import { evaluateQualification } from '../services/qualificationService';
import { isQualificationRequired } from '../constants/serviceConfig';
import { Qualification } from '../types';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
};

const baseQualification: Qualification = {
  id: 'q1',
  volunteer_id: 'v1',
  service_type: 'medical_assist',
  status: 'active',
  valid_from: new Date('2026-01-01T00:00:00Z'),
  valid_until: new Date('2026-06-30T23:59:59Z'),
  issued_by: 'admin',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const runTests = (): void => {
  console.log('\n========================================');
  console.log('  按服务类型生效的资格 - 纯逻辑验证');
  console.log('========================================\n');

  // 哪些类型需要资格
  assert('医疗辅助需要资格', isQualificationRequired('medical_assist') === true);
  assert('救灾援助需要资格', isQualificationRequired('disaster_relief') === true);
  assert('文化活动不需要资格', isQualificationRequired('cultural_activity') === false);
  assert('社区服务不需要资格', isQualificationRequired('community_service') === false);
  assert('老人陪护不需要资格', isQualificationRequired('elderly_care') === false);

  // 无资格
  assert('无资格记录 -> 缺资格', evaluateQualification(undefined, '2026-03-01').valid === false);
  const missing = evaluateQualification(undefined, '2026-03-01');
  assert('无资格原因=missing', !missing.valid && missing.reason === 'missing');

  // 区间内
  assert('服务日期在有效期内 -> 有效', evaluateQualification(baseQualification, '2026-03-15').valid === true);

  // 边界：生效日当天与到期日当天均有效（按日比较）
  assert('生效日当天有效', evaluateQualification(baseQualification, '2026-01-01').valid === true);
  assert('到期日当天仍有效', evaluateQualification(baseQualification, '2026-06-30').valid === true);

  // 未生效 / 已过期
  const before = evaluateQualification(baseQualification, '2025-12-31');
  assert('早于生效日 -> not_effective', !before.valid && before.reason === 'not_effective');
  const after = evaluateQualification(baseQualification, '2026-07-01');
  assert('晚于到期日 -> expired', !after.valid && after.reason === 'expired');

  // 非 active 状态一律无效（续期留档、撤销、过期归档）
  for (const status of ['renewed', 'revoked', 'expired'] as const) {
    const result = evaluateQualification({ ...baseQualification, status }, '2026-03-15');
    assert(`状态 ${status} 在服务日期无效`, result.valid === false, `期望无效，实际有效`);
  }

  // 撤销后即使日期在原区间内也立即失效
  const revoked = evaluateQualification(
    { ...baseQualification, status: 'revoked', revoked_at: new Date('2026-02-01T00:00:00Z') },
    '2026-03-15'
  );
  assert('撤销后原有效期内也立即失效', revoked.valid === false);

  // 续期场景：旧资格 renewed 留档，新资格 active
  const renewedOld = evaluateQualification({ ...baseQualification, status: 'renewed' }, '2026-03-15');
  const renewedNew = evaluateQualification(
    {
      ...baseQualification,
      id: 'q2',
      valid_from: new Date('2026-07-01T00:00:00Z'),
      valid_until: new Date('2026-12-31T23:59:59Z'),
    },
    '2026-08-01'
  );
  assert('续期后旧资格不再命中', renewedOld.valid === false);
  assert('续期后新资格在新日期有效', renewedNew.valid === true);

  console.log('\n========================================');
  console.log('  测试结果汇总');
  console.log('========================================');
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  console.log(`总计: ${testResults.length} 个用例`);
  console.log(`通过: ${passed} 个 ✓`);
  console.log(`失败: ${failed} 个 ✗`);
  console.log('\n========================================\n');
  process.exit(failed > 0 ? 1 : 0);
};

runTests();
