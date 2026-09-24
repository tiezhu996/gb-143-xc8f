import dotenv from 'dotenv';
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
} from '../services/qualificationService';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const daysFromNow = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  按服务类型生效的资格 - 集成验证用例');
  console.log('  测试: 登记/续期/撤销 + 单条/批量录入核验');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建两名志愿者 ---');
    const v1Result = await createVolunteer('资格测试-医疗', '13900001111', 'qual-med@example.com');
    const v2Result = await createVolunteer('资格测试-救灾', '13900002222', 'qual-disaster@example.com');
    assert('志愿者1创建成功', v1Result.success && !!v1Result.data, '创建失败', v1Result);
    assert('志愿者2创建成功', v2Result.success && !!v2Result.data, '创建失败', v2Result);
    const v1 = v1Result.data!.id;
    const v2 = v2Result.data!.id;

    console.log('\n--- 用例1: 普通类型无需资格，直接录入成功 ---');
    const ordinary = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'cultural_activity',
      duration_hours: 2,
      rating: 5,
      is_no_show: false,
    } as any);
    assert('文化活动直接录入成功', ordinary.success === true, '普通类型应可直接录入', ordinary);
    const v1AfterOrdinary = (await getVolunteerById(v1)).data!;
    assert('普通录入后积分增加', v1AfterOrdinary.total_points > 0,
      `期望>0，实际${v1AfterOrdinary.total_points}`);

    console.log('\n--- 用例2: 无资格录入医疗辅助 -> 单条拒绝且无任何变更 ---');
    const beforeMed = (await getVolunteerById(v1)).data!;
    const noQualMed = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'medical_assist',
      duration_hours: 3,
      rating: 5,
      is_no_show: false,
    } as any);
    assert('无资格医疗辅助被拒绝', noQualMed.success === false, '应被拒绝', noQualMed);
    assert('拒绝原因包含医疗辅助', (noQualMed.error || '').includes('医疗辅助'),
      `实际: ${noQualMed.error}`);
    assert('返回违规人员与类型',
      noQualMed.details?.violations?.[0]?.volunteer_id === v1 &&
      noQualMed.details?.violations?.[0]?.service_type === 'medical_assist',
      '应返回人员和类型', noQualMed.details);
    const afterMed = (await getVolunteerById(v1)).data!;
    assert('积分不变', afterMed.total_points === beforeMed.total_points,
      `${afterMed.total_points} vs ${beforeMed.total_points}`);
    assert('次数不变', afterMed.service_count === beforeMed.service_count,
      `${afterMed.service_count} vs ${beforeMed.service_count}`);
    assert('信用不变', afterMed.credit_score === beforeMed.credit_score,
      `${afterMed.credit_score} vs ${beforeMed.credit_score}`);

    console.log('\n--- 用例3: 管理员登记医疗辅助资格（含有效期） ---');
    const issued = await issueQualification(v1, {
      service_type: 'medical_assist',
      valid_from: daysFromNow(0),
      valid_until: daysFromNow(30),
      certificate_no: 'MED-001',
    }, 'test-admin');
    assert('资格登记成功', issued.success === true, '登记失败', issued);

    const duplicate = await issueQualification(v1, {
      service_type: 'medical_assist',
      valid_from: daysFromNow(0),
      valid_until: daysFromNow(60),
    }, 'test-admin');
    assert('同一类型重复登记被拒绝', duplicate.success === false, '同一类型只允许一份有效资格', duplicate);

    console.log('\n--- 用例4: 持有效资格录入当前日期医疗辅助 -> 成功 ---');
    const withQual = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'medical_assist',
      duration_hours: 3,
      rating: 5,
      is_no_show: false,
    } as any);
    assert('持资格录入成功', withQual.success === true, '应成功', withQual);

    console.log('\n--- 用例5: 按服务日期核验 - 资格生效前的服务日期被拒 ---');
    const futureVol = await createVolunteer('资格测试-未来生效', '13900003333', 'qual-future@example.com');
    const v3 = futureVol.data!.id;
    await issueQualification(v3, {
      service_type: 'medical_assist',
      valid_from: daysFromNow(10),
      valid_until: daysFromNow(40),
    }, 'test-admin');
    const beforeEffective = await createServiceRecord({
      volunteer_id: v3,
      service_type: 'medical_assist',
      duration_hours: 2,
      rating: 5,
      recorded_at: new Date(daysFromNow(1)).toISOString(),
    } as any);
    assert('生效日之前的服务被拒绝', beforeEffective.success === false, '应因未生效被拒', beforeEffective);
    assert('提示早于生效日', (beforeEffective.error || '').includes('生效'),
      `实际: ${beforeEffective.error}`);
    const withinEffective = await createServiceRecord({
      volunteer_id: v3,
      service_type: 'medical_assist',
      duration_hours: 2,
      rating: 5,
      recorded_at: new Date(daysFromNow(15)).toISOString(),
    } as any);
    assert('有效期内服务日期成功', withinEffective.success === true, '应成功', withinEffective);

    console.log('\n--- 用例6: 续期 -> 旧资格留档 renewed，新资格 active ---');
    const renewed = await renewQualification(v1, {
      service_type: 'medical_assist',
      valid_from: daysFromNow(31),
      valid_until: daysFromNow(90),
      certificate_no: 'MED-002',
    }, 'test-admin');
    assert('续期成功', renewed.success === true, '续期失败', renewed);
    const quals = await getVolunteerQualifications(v1);
    assert('查到当前资格', quals.data!.current.length === 1, '应有1份当前资格', quals.data);
    const history = quals.data!.history as any[];
    assert('留档中有 renewed 旧资格', history.some(q => q.status === 'renewed'), '旧资格应留档为renewed', history);
    assert('当前资格为 active 且是新证书',
      quals.data!.current[0].status === 'active' &&
      quals.data!.current[0].certificate_no === 'MED-002',
      '新资格应生效', quals.data!.current);

    console.log('\n--- 用例7: 撤销 -> 立即失效，录入被拒 ---');
    const activeId = quals.data!.current[0].id;
    const revoked = await revokeQualification(activeId, 'test-admin', '发现资格材料造假');
    assert('撤销成功', revoked.success === true, '撤销失败', revoked);
    const afterRevoke = await getVolunteerQualifications(v1);
    assert('撤销后无当前资格', afterRevoke.data!.current.length === 0, '撤销后不应有当前资格', afterRevoke.data);
    const medAfterRevoke = await createServiceRecord({
      volunteer_id: v1,
      service_type: 'medical_assist',
      duration_hours: 2,
      rating: 5,
    } as any);
    assert('撤销后录入医疗辅助被拒', medAfterRevoke.success === false, '应立即失效', medAfterRevoke);
    const revokeAgain = await revokeQualification(activeId, 'test-admin', '再次撤销');
    assert('重复撤销被拒绝', revokeAgain.success === false, '非有效资格不可撤销', revokeAgain);

    console.log('\n--- 用例8: 志愿者详情(summary)包含当前资格与有效期 ---');
    const summary = await getVolunteerSummary(v3);
    const summaryQuals = summary.data!.qualifications as any[];
    assert('summary含资格数组', Array.isArray(summaryQuals), '应返回资格数组');
    const v3Current = summaryQuals.find((q: any) => q.service_type === 'medical_assist');
    assert('summary含当前医疗资格与有效期',
      !!v3Current && !!v3Current.valid_from && !!v3Current.valid_until,
      '应含有效期', v3Current);

    console.log('\n--- 用例9: 批量录入 - 一人资格不符则整批拒绝，全部数据不变 ---');
    // v2 没有救灾资格；批次中混入 v2 的救灾记录
    await issueQualification(v1, {
      service_type: 'disaster_relief',
      valid_from: daysFromNow(0),
      valid_until: daysFromNow(30),
    }, 'test-admin');
    const snapshotV1 = (await getVolunteerById(v1)).data!;
    const snapshotV2 = (await getVolunteerById(v2)).data!;

    const batch = await batchCreateServiceRecords([
      { volunteer_id: v1, service_type: 'disaster_relief', duration_hours: 4, rating: 5 } as any,
      { volunteer_id: v2, service_type: 'medical_assist', duration_hours: 2, rating: 5 } as any,
      { volunteer_id: v2, service_type: 'cultural_activity', duration_hours: 1, rating: 5 } as any,
    ]);
    assert('批量被整批拒绝', batch.success === false, '应整批拒绝', batch);
    assert('批量返回违规人员和类型',
      (batch.details?.violations || []).some((x: any) => x.volunteer_id === v2 && x.service_type === 'medical_assist'),
      '应返回v2+medical_assist', batch.details);
    assert('批量违规数为1（普通类型文化活动不算违规）',
      batch.details?.violations?.length === 1,
      `实际${batch.details?.violations?.length}`, batch.details);

    const laterV1 = (await getVolunteerById(v1)).data!;
    const laterV2 = (await getVolunteerById(v2)).data!;
    assert('v1积分不变（整批未落库）', laterV1.total_points === snapshotV1.total_points,
      `${laterV1.total_points} vs ${snapshotV1.total_points}`);
    assert('v1次数不变', laterV1.service_count === snapshotV1.service_count,
      `${laterV1.service_count} vs ${snapshotV1.service_count}`);
    assert('v2积分不变', laterV2.total_points === snapshotV2.total_points,
      `${laterV2.total_points} vs ${snapshotV2.total_points}`);
    assert('v2次数不变', laterV2.service_count === snapshotV2.service_count,
      `${laterV2.service_count} vs ${snapshotV2.service_count}`);
    assert('v2信用不变', laterV2.credit_score === snapshotV2.credit_score,
      `${laterV2.credit_score} vs ${snapshotV2.credit_score}`);

    console.log('\n--- 用例10: 全部合规的批量录入成功 ---');
    const okBatch = await batchCreateServiceRecords([
      { volunteer_id: v1, service_type: 'disaster_relief', duration_hours: 4, rating: 5 } as any,
      { volunteer_id: v1, service_type: 'community_service', duration_hours: 2, rating: 5 } as any,
    ]);
    assert('合规批量成功', okBatch.success === true && okBatch.data?.successCount === 2,
      '应全部成功', okBatch.data);

    console.log('\n--- 用例11: 普通类型不给登记资格（配置驱动） ---');
    const ordinaryIssue = await issueQualification(v1, {
      service_type: 'cultural_activity',
      valid_from: daysFromNow(0),
      valid_until: daysFromNow(10),
    }, 'test-admin');
    assert('文化活动类型登记资格被拒', ordinaryIssue.success === false, '普通类型无需资格', ordinaryIssue);

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
