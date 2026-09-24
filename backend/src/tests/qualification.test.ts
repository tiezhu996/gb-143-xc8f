// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/embedded-postgres.d.ts" />
import type EmbeddedPostgresType from 'embedded-postgres';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createVolunteer, getVolunteerById, getVolunteerSummary } from '../services/volunteerManager';
import {
  createServiceRecord,
  batchCreateServiceRecords,
} from '../services/volunteerService';
import {
  issueQualification,
  renewQualification,
  revokeQualification,
  getVolunteerQualifications,
  evaluateQualificationAtDate,
} from '../services/qualificationService';
import { messages } from '../constants/messages';
import { Qualification, Volunteer } from '../types';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  console.log(`${condition ? '✓ PASS' : '✗ FAIL'} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (!condition && details !== undefined) {
    console.log('  Details:', JSON.stringify(details, null, 2));
  }
};

const isoDate = (offsetDays: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const snapshot = async (volunteerId: string): Promise<{ total_points: number; service_count: number; credit_score: number } | undefined> => {
  const result = await getVolunteerById(volunteerId);
  const v = result.data as Volunteer;
  return {
    total_points: v.total_points,
    service_count: v.service_count,
    credit_score: v.credit_score,
  };
};

const runTests = async (): Promise<number> => {
  console.log('\n========================================');
  console.log('  按服务类型生效的资格 - 集成验证');
  console.log('========================================\n');

  try {
    console.log('--- 用例1: 登记资格（医疗辅助） ---');
    const v1Result = await createVolunteer('测试志愿者-资格A', '13911111111', 'qual-a@example.com');
    assert('创建志愿者A成功', v1Result.success && !!v1Result.data, undefined, v1Result);
    const v1Id = v1Result.data!.id;

    const issueResult = await issueQualification({
      volunteerId: v1Id,
      serviceType: 'medical_assist',
      validFrom: isoDate(-30),
      validUntil: isoDate(0),
      adminId: 'test-admin',
      note: '红十字急救证（旧证）',
    });
    assert('医疗辅助资格登记成功', issueResult.success === true, issueResult.error, issueResult);
    assert('新资格状态为 active', issueResult.data?.status === 'active', undefined, issueResult.data);
    const qualId = issueResult.data?.id as string;

    const duplicateIssue = await issueQualification({
      volunteerId: v1Id,
      serviceType: 'medical_assist',
      validUntil: isoDate(60),
      adminId: 'test-admin',
    });
    assert('同一类型重复登记被拒绝', duplicateIssue.success === false, '应提示已有有效资格');
    assert('重复登记返回明确错误', duplicateIssue.error === messages.qualifications.activeExists,
      `实际: ${duplicateIssue.error}`);

    const before1 = await snapshot(v1Id);
    const medicalRecord = await createServiceRecord({
      volunteer_id: v1Id,
      service_type: 'medical_assist',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '持有效资格的医疗辅助服务',
    } as any);
    assert('持有效资格可录入医疗辅助记录', medicalRecord.success === true, medicalRecord.error, medicalRecord);
    assert('医疗辅助积分正确(2h*10*1.6*1.2评分=38)', medicalRecord.data?.pointsChange === 38,
      `实际: ${medicalRecord.data?.pointsChange}`);

    console.log('\n--- 用例2: 无资格不可录入受限类型 ---');
    const v2Result = await createVolunteer('测试志愿者-资格B', '13922222222', 'qual-b@example.com');
    const v2Id = v2Result.data!.id;
    const before2 = await snapshot(v2Id);

    const noQualRecord = await createServiceRecord({
      volunteer_id: v2Id,
      service_type: 'disaster_relief',
      duration_hours: 3,
      rating: 5,
      is_no_show: false,
      description: '无资格救灾服务',
    } as any);
    assert('无资格录入救灾援助被拒绝', noQualRecord.success === false, '应整单拒绝', noQualRecord);
    assert('拒绝原因：不具备资格', noQualRecord.error === messages.qualifications.missing, `实际: ${noQualRecord.error}`);
    assert('拒绝详情返回人员和类型',
      noQualRecord.details?.volunteer_id === v2Id && noQualRecord.details?.service_type === 'disaster_relief',
      undefined, noQualRecord.details);

    const after2 = await snapshot(v2Id);
    assert('拒绝后积分不变', after2!.total_points === before2!.total_points);
    assert('拒绝后服务次数不变', after2!.service_count === before2!.service_count);
    assert('拒绝后信用分不变', after2!.credit_score === before2!.credit_score);

    console.log('\n--- 用例3: 普通类型无需资格照常录入 ---');
    const culturalRecord = await createServiceRecord({
      volunteer_id: v2Id,
      service_type: 'cultural_activity',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
      description: '文化活动',
    } as any);
    assert('文化活动可直接录入', culturalRecord.success === true, culturalRecord.error);
    assert('文化活动积分正确(2h*10*1.0*1.2=24)', culturalRecord.data?.pointsChange === 24);

    const communityRecord = await createServiceRecord({
      volunteer_id: v2Id,
      service_type: 'community_service',
      duration_hours: 1,
      rating: 5,
      is_no_show: false,
      description: '社区服务',
    } as any);
    assert('社区服务可直接录入', communityRecord.success === true, communityRecord.error);
    assert('社区服务积分正确(1h*10*1.2*1.2=14)', communityRecord.data?.pointsChange === 14);

    console.log('\n--- 用例4: 批量录入整批拒绝，人员/类型/积分不变 ---');
    const batchResult = await batchCreateServiceRecords([
      { volunteer_id: v2Id, service_type: 'medical_assist', duration_hours: 2, rating: 5, description: '批量-无资格' } as any,
      { volunteer_id: v1Id, service_type: 'medical_assist', duration_hours: 1, rating: 5, description: '批量-有资格' } as any,
      { volunteer_id: v1Id, service_type: 'community_service', duration_hours: 1, rating: 5, description: '批量-普通类型' } as any,
    ]);
    assert('批量中存在无资格记录时整批拒绝', batchResult.success === false, undefined, batchResult);
    assert('整批拒绝错误信息', batchResult.error === messages.qualifications.batchRejected, `实际: ${batchResult.error}`);
    const violations = batchResult.details?.violations || [];
    assert('违规清单返回人员和类型',
      violations.some((x: any) => x.volunteer_id === v2Id && x.service_type === 'medical_assist'),
      undefined, violations);
    assert('违规清单包含志愿者姓名', !!violations[0]?.volunteer_name, undefined, violations);

    const afterBatchV1 = await snapshot(v1Id);
    const afterBatchV2 = await snapshot(v2Id);
    assert('整批拒绝后志愿者A积分不变', afterBatchV1!.total_points === before1!.total_points + 38,
      `A积分: ${afterBatchV1!.total_points}`);
    assert('整批拒绝后志愿者A次数不变', afterBatchV1!.service_count === 1,
      `A次数: ${afterBatchV1!.service_count}`);
    assert('整批拒绝后志愿者B积分不变', afterBatchV2!.total_points === before2!.total_points + 38,
      `B积分: ${afterBatchV2!.total_points}`);
    assert('整批拒绝后志愿者B次数不变', afterBatchV2!.service_count === 2,
      `B次数: ${afterBatchV2!.service_count}`);

    const batchAllValid = await batchCreateServiceRecords([
      { volunteer_id: v1Id, service_type: 'medical_assist', duration_hours: 1, rating: 5, description: '批量-全部合规1' } as any,
      { volunteer_id: v2Id, service_type: 'cultural_activity', duration_hours: 1, rating: 5, description: '批量-全部合规2' } as any,
    ]);
    assert('批量全部合规时成功录入', batchAllValid.success === true && batchAllValid.data?.successCount === 2,
      undefined, batchAllValid);

    console.log('\n--- 用例5: 续期后旧资格留档，同类型仅一份 active ---');
    const renewResult = await renewQualification({
      qualificationId: qualId,
      validUntil: isoDate(60),
      adminId: 'test-admin',
      note: '急救证复审通过',
    });
    assert('续期成功', renewResult.success === true, renewResult.error, renewResult);
    assert('旧资格状态为 renewed（留档）', renewResult.data?.old.status === 'renewed');
    assert('新资格状态为 active', renewResult.data?.current.status === 'active');
    assert('新资格有效期紧接旧资格',
      renewResult.data?.current.valid_from === isoDate(1) &&
      renewResult.data?.current.valid_until === isoDate(60),
      undefined, renewResult.data?.current);
    assert('新资格关联旧资格ID', renewResult.data?.current.renewed_from_id === qualId);

    const qualsAfterRenew = await getVolunteerQualifications(v1Id);
    assert('详情可查到当前资格', qualsAfterRenew.data!.current.some(q => q.status === 'active' && q.service_type === 'medical_assist'));
    assert('详情可查到留档旧资格', qualsAfterRenew.data!.history.some(q => q.status === 'renewed'));
    assert('同一类型只有一份有效资格',
      qualsAfterRenew.data!.current.filter(q => q.service_type === 'medical_assist').length === 1);

    const oldRecordBackdated = await createServiceRecord({
      volunteer_id: v1Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '补录续期前旧资格有效期内的服务',
      recorded_at: `${isoDate(-10)}T09:00:00.000Z`,
    } as any);
    assert('旧资格有效期内的历史服务可补录', oldRecordBackdated.success === true,
      oldRecordBackdated.error, oldRecordBackdated);

    console.log('\n--- 用例6: 撤销后立即失效 ---');
    const currentQualId = renewResult.data!.current.id;
    const revokeResult = await revokeQualification({
      qualificationId: currentQualId,
      adminId: 'test-admin',
      reason: '提供虚假证明材料',
    });
    assert('撤销成功', revokeResult.success === true, revokeResult.error);
    assert('撤销后状态为 revoked', revokeResult.data?.status === 'revoked');
    assert('记录了撤销时间', !!revokeResult.data?.revoked_at);
    assert('记录了撤销人和原因',
      revokeResult.data?.revoked_by === 'test-admin' && revokeResult.data?.revoke_reason === '提供虚假证明材料');

    const afterRevokeRecord = await createServiceRecord({
      volunteer_id: v1Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '撤销后尝试排班（落在新资格区间内）',
      recorded_at: `${isoDate(20)}T09:00:00.000Z`,
    } as any);
    assert('撤销后新资格区间内的医疗辅助记录被拒绝', afterRevokeRecord.success === false);
    assert('拒绝原因：资格已被撤销', afterRevokeRecord.error === messages.qualifications.revokedAtServiceDate,
      `实际: ${afterRevokeRecord.error}`);

    const afterRevoke = await snapshot(v1Id);
    assert('撤销拒绝后积分不变',
      afterRevoke!.total_points === before1!.total_points + 38 + 19 + 19,
      `实际积分: ${afterRevoke!.total_points}`);

    const beforeRevokeRecord = await createServiceRecord({
      volunteer_id: v1Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '撤销日之前、旧资格区间内的服务补录',
      recorded_at: `${isoDate(-5)}T09:00:00.000Z`,
    } as any);
    assert('撤销日期之前、资格有效期内的历史记录仍可补录', beforeRevokeRecord.success === true,
      beforeRevokeRecord.error);

    const revokeAgain = await revokeQualification({
      qualificationId: currentQualId,
      adminId: 'test-admin',
      reason: '重复撤销',
    });
    assert('已撤销资格不可再次撤销', revokeAgain.success === false && revokeAgain.error === messages.qualifications.notActive);

    const renewRevoked = await renewQualification({
      qualificationId: currentQualId,
      validUntil: isoDate(90),
      adminId: 'test-admin',
    });
    assert('已撤销资格不可直接续期（须重新登记）', renewRevoked.success === false);

    const reissueResult = await issueQualification({
      volunteerId: v1Id,
      serviceType: 'medical_assist',
      validFrom: isoDate(0),
      validUntil: isoDate(90),
      adminId: 'test-admin',
      note: '重新考取证书',
    });
    assert('撤销后可重新登记资格', reissueResult.success === true, reissueResult.error);

    // 单独验证：单资格（无续期链）撤销后，撤销日前的历史区间仍可补录
    const v5Result = await createVolunteer('测试志愿者-资格E', '13955555555', 'qual-e@example.com');
    const v5Id = v5Result.data!.id;
    const v5Qual = await issueQualification({
      volunteerId: v5Id,
      serviceType: 'medical_assist',
      validFrom: isoDate(-20),
      validUntil: isoDate(20),
      adminId: 'test-admin',
    });
    const v5Revoke = await revokeQualification({
      qualificationId: v5Qual.data!.id,
      adminId: 'test-admin',
      reason: '单资格撤销测试',
    });
    assert('单资格撤销成功', v5Revoke.success === true, v5Revoke.error);
    const v5Backfill = await createServiceRecord({
      volunteer_id: v5Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '撤销前历史区间补录',
      recorded_at: `${isoDate(-10)}T09:00:00.000Z`,
    } as any);
    assert('单资格撤销后，撤销日前历史服务仍可补录', v5Backfill.success === true, v5Backfill.error);
    const v5Today = await createServiceRecord({
      volunteer_id: v5Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '撤销当日服务',
    } as any);
    assert('单资格撤销当日即被拒绝', v5Today.success === false && v5Today.error === messages.qualifications.revokedAtServiceDate);

    console.log('\n--- 用例7: 有效期边界（未生效/已过期） ---');
    const v3Result = await createVolunteer('测试志愿者-资格C', '13933333333', 'qual-c@example.com');
    const v3Id = v3Result.data!.id;

    const futureIssue = await issueQualification({
      volunteerId: v3Id,
      serviceType: 'disaster_relief',
      validFrom: isoDate(5),
      validUntil: isoDate(35),
      adminId: 'test-admin',
    });
    assert('可登记未来生效的资格', futureIssue.success === true, futureIssue.error);
    const beforeFuture = await snapshot(v3Id);
    const notYetValidRecord = await createServiceRecord({
      volunteer_id: v3Id,
      service_type: 'disaster_relief',
      duration_hours: 1,
      rating: 5,
      recorded_at: `${isoDate(2)}T09:00:00.000Z`,
      description: '资格尚未生效',
    } as any);
    assert('生效日前的服务被拒绝', notYetValidRecord.success === false);
    assert('拒绝原因：尚未生效', notYetValidRecord.error === messages.qualifications.notYetValid,
      `实际: ${notYetValidRecord.error}`);
    const futureActiveRecord = await createServiceRecord({
      volunteer_id: v3Id,
      service_type: 'disaster_relief',
      duration_hours: 1,
      rating: 5,
      recorded_at: `${isoDate(5)}T09:00:00.000Z`,
      description: '资格生效首日',
    } as any);
    assert('生效首日可录入', futureActiveRecord.success === true, futureActiveRecord.error);
    void beforeFuture;

    const expiredRecord = await createServiceRecord({
      volunteer_id: v3Id,
      service_type: 'disaster_relief',
      duration_hours: 1,
      rating: 5,
      recorded_at: `${isoDate(40)}T09:00:00.000Z`,
      description: '资格已过期',
    } as any);
    assert('到期日后的服务被拒绝', expiredRecord.success === false);
    assert('拒绝原因：已过有效期', expiredRecord.error === messages.qualifications.expired,
      `实际: ${expiredRecord.error}`);

    console.log('\n--- 用例8: 志愿者详情包含当前资格与有效期 ---');
    const summary = await getVolunteerSummary(v1Id);
    const summaryQuals = summary.data?.qualifications || [];
    assert('汇总接口返回资格列表', Array.isArray(summaryQuals) && summaryQuals.length >= 1);
    assert('汇总资格含服务类型和有效期',
      summaryQuals.some((q: Qualification) =>
        q.service_type === 'medical_assist' &&
        q.status === 'active' &&
        !!q.valid_from &&
        !!q.valid_until),
      undefined, summaryQuals);
    assert('汇总接口返回历史资格', (summary.data?.qualification_history || []).length >= 2);

    console.log('\n--- 用例9: 过期资格自动失效后可重新登记 ---');
    const v4Result = await createVolunteer('测试志愿者-资格D', '13944444444', 'qual-d@example.com');
    const v4Id = v4Result.data!.id;
    const pastIssue = await issueQualification({
      volunteerId: v4Id,
      serviceType: 'medical_assist',
      validFrom: isoDate(-20),
      validUntil: isoDate(-1),
      adminId: 'test-admin',
    });
    assert('登记过去到期的资格成功', pastIssue.success === true, pastIssue.error);
    const qualsV4 = await getVolunteerQualifications(v4Id);
    assert('过期资格被自动标记 expired', qualsV4.data!.history.some(q => q.status === 'expired'));
    assert('过期资格不在当前有效列表', !qualsV4.data!.current.some(q => q.service_type === 'medical_assist'));
    const expiredNow = await createServiceRecord({
      volunteer_id: v4Id,
      service_type: 'medical_assist',
      duration_hours: 1,
      rating: 5,
      description: '过期资格当日服务',
    } as any);
    assert('持过期资格录入被拒绝', expiredNow.success === false && expiredNow.error === messages.qualifications.expired);
    const reIssueV4 = await issueQualification({
      volunteerId: v4Id,
      serviceType: 'medical_assist',
      validUntil: isoDate(10),
      adminId: 'test-admin',
    });
    assert('过期后可重新登记', reIssueV4.success === true, reIssueV4.error);

    console.log('\n--- 用例10: 纯函数 evaluateQualificationAtDate 边界核验 ---');
    const mkRow = (over: Partial<Qualification>): Qualification => ({
      id: 'q1', volunteer_id: 'v', service_type: 'medical_assist',
      status: 'active', valid_from: isoDate(-5), valid_until: isoDate(5),
      issued_by: 'admin', created_at: new Date(), updated_at: new Date(), ...over,
    });
    assert('区间首日有效', evaluateQualificationAtDate([mkRow({})], isoDate(-5)).valid === true);
    assert('区间末日有效', evaluateQualificationAtDate([mkRow({})], isoDate(5)).valid === true);
    assert('区间外（之后）无效', evaluateQualificationAtDate([mkRow({})], isoDate(6)).valid === false);
    assert('空记录无效', evaluateQualificationAtDate([], isoDate(0)).valid === false);
    const revokedRow = mkRow({
      id: 'q-new',
      status: 'revoked',
      valid_from: isoDate(-30),
      valid_until: isoDate(20),
      revoked_at: new Date(`${isoDate(0)}T15:00:00.000Z`),
      created_at: new Date(Date.now() + 1000),
    });
    const oldRenewedRow = mkRow({
      id: 'q-old',
      status: 'renewed',
      valid_from: isoDate(-60),
      valid_until: isoDate(-1),
      created_at: new Date(Date.now() - 1000),
    });
    assert('撤销当日视为已失效（日粒度）', evaluateQualificationAtDate([revokedRow], isoDate(0)).valid === false);
    assert('单资格撤销日前的历史区间仍有效', evaluateQualificationAtDate([revokedRow], isoDate(-10)).valid === true);
    assert('撤销前一日、且在旧留档资格区间内仍有效',
      evaluateQualificationAtDate([revokedRow, oldRenewedRow], isoDate(-10)).valid === true);
    assert('撤销日之后、撤销区间内仍拒绝（覆盖性）',
      evaluateQualificationAtDate([revokedRow, oldRenewedRow], isoDate(10)).valid === false);
    const renewedRow = mkRow({ status: 'renewed', valid_from: isoDate(-30), valid_until: isoDate(-1) });
    assert('留档资格在其旧区间内有效', evaluateQualificationAtDate([renewedRow], isoDate(-10)).valid === true);

    console.log('\n--- 用例11: 不存在的志愿者 ---');
    const missingBatch = await batchCreateServiceRecords([
      {
        volunteer_id: '00000000-0000-0000-0000-000000000000',
        service_type: 'medical_assist',
        duration_hours: 1,
        rating: 5,
      } as any,
    ]);
    assert('批量中志愿者不存在时整批拒绝', missingBatch.success === false);
    assert('违规原因：志愿者不存在',
      missingBatch.details?.violations?.[0]?.reason === messages.volunteers.notFound,
      undefined, missingBatch.details);

    const failed = testResults.filter(r => !r.passed).length;
    const passed = testResults.filter(r => r.passed).length;
    console.log('\n========================================');
    console.log(`测试结果: 通过 ${passed} / 总计 ${testResults.length}，失败 ${failed}`);
    console.log('========================================\n');
    return failed > 0 ? 1 : 0;
  } catch (error) {
    console.error('测试执行出错:', error);
    return 1;
  }
};

const main = async (): Promise<void> => {
  // CommonJS 输出下保留原生动态 import（embedded-postgres 为 ESM-only）
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (s: string) => Promise<{ default: typeof EmbeddedPostgresType }>;
  const EmbeddedPostgres = (await dynamicImport('embedded-postgres')).default;
  const pg = new EmbeddedPostgres({
    databaseDir: '/tmp/pgtest-data-qual',
    user: 'volunteer_user',
    password: 'volunteer_pass',
    port: 5744,
    persistent: false,
  });

  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '5744';
  process.env.DB_NAME = 'volunteer_db';
  process.env.DB_USER = 'volunteer_user';
  process.env.DB_PASSWORD = 'volunteer_pass';

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('volunteer_db');
    await createTables();

    const exitCode = await runTests();
    process.exit(exitCode);
  } catch (error) {
    console.error('环境启动失败:', error);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  }
};

main();
