import { ApiResponse, Qualification, QualificationViolation, ServiceRecord } from '../types';
import { PoolClient } from 'pg';
import pool from '../db/pool';
import { SERVICE_TYPE_WEIGHTS } from '../types';
import { isQualificationRequired } from '../constants/serviceConfig';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export interface QualificationInput {
  service_type: string;
  valid_from?: Date | string;
  valid_until: Date | string;
  certificate_no?: string;
}

export type QualificationValidity =
  | { valid: true; qualification: Qualification }
  | { valid: false; reason: string };

export const getServiceTypeName = (serviceType: string): string =>
  SERVICE_TYPE_WEIGHTS.find(t => t.type === serviceType)?.name || serviceType;

const toDateOnly = (value: Date | string): Date => new Date(new Date(value).toISOString().slice(0, 10) + 'T00:00:00Z');

const formatDate = (value: Date | string): string => new Date(value).toISOString().slice(0, 10);

/**
 * 判断某份资格在指定服务日期是否有效（纯函数，便于单测）：
 * - 仅 status=active 的资格可被判定有效；续期留档、撤销、已归档过期均不算
 * - 服务日期落在 [valid_from, valid_until] 日期区间内（按日比较，到期当日仍有效）
 */
export const evaluateQualification = (
  qualification: Qualification | undefined | null,
  serviceDate: Date | string
): QualificationValidity => {
  const day = formatDate(serviceDate);

  if (!qualification || qualification.status !== 'active') {
    return { valid: false, reason: 'missing' };
  }
  if (day < formatDate(qualification.valid_from)) {
    return { valid: false, reason: 'not_effective' };
  }
  if (day > formatDate(qualification.valid_until)) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, qualification };
};

const describeReason = (
  serviceType: string,
  result: Extract<QualificationValidity, { valid: false }>,
  qualification?: Qualification
): string => {
  const name = getServiceTypeName(serviceType);
  switch (result.reason) {
    case 'not_effective':
      return qualification
        ? messages.qualifications.notEffective(name, formatDate(qualification.valid_from))
        : messages.qualifications.missing(name);
    case 'expired':
      return qualification
        ? messages.qualifications.expired(name, formatDate(qualification.valid_until))
        : messages.qualifications.missing(name);
    default:
      return messages.qualifications.missing(name);
  }
};

/** 将该类型下已过期但尚未归档的 active 资格标记为 expired（留档） */
const archiveExpired = async (client: PoolClient, volunteerId: string, serviceType: string): Promise<void> => {
  await client.query(
    `UPDATE volunteer_qualifications
       SET status = 'expired'
     WHERE volunteer_id = $1
       AND service_type = $2
       AND status = 'active'
       AND valid_until::date < CURRENT_DATE`,
    [volunteerId, serviceType]
  );
};

const getActiveQualification = async (
  client: PoolClient,
  volunteerId: string,
  serviceType: string
): Promise<Qualification | undefined> => {
  const result = await client.query(
    `SELECT * FROM volunteer_qualifications
     WHERE volunteer_id = $1 AND service_type = $2 AND status = 'active'`,
    [volunteerId, serviceType]
  );
  return result.rows[0] as Qualification | undefined;
};

const validatePeriod = (input: QualificationInput): { from: Date; until: Date } | null => {
  const from = input.valid_from ? toDateOnly(input.valid_from) : toDateOnly(new Date());
  const until = toDateOnly(input.valid_until);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until < from) {
    return null;
  }
  return { from, until };
};

export const issueQualification = async (
  volunteerId: string,
  input: QualificationInput,
  adminId: string
): Promise<ApiResponse<Qualification>> => {
  if (!SERVICE_TYPE_WEIGHTS.some(t => t.type === input.service_type)) {
    return { success: false, error: messages.qualifications.invalidType };
  }
  if (!isQualificationRequired(input.service_type)) {
    return { success: false, error: messages.qualifications.typeNotRequired };
  }
  const period = validatePeriod(input);
  if (!period) {
    return { success: false, error: messages.qualifications.invalidDateRange };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query('SELECT id FROM volunteers WHERE id = $1', [volunteerId]);
    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    await archiveExpired(client, volunteerId, input.service_type);
    const existing = await getActiveQualification(client, volunteerId, input.service_type);
    if (existing) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.activeExists };
    }

    const insertResult = await client.query(
      `INSERT INTO volunteer_qualifications
         (volunteer_id, service_type, status, valid_from, valid_until, certificate_no, issued_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6)
       RETURNING *`,
      [volunteerId, input.service_type, period.from, period.until, input.certificate_no, adminId]
    );
    const qualification = insertResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, 'qualification_issue', 'volunteer_qualification', $2, $3, $4)`,
      [
        adminId,
        qualification.id,
        {
          volunteer_id: volunteerId,
          service_type: input.service_type,
          valid_from: formatDate(period.from),
          valid_until: formatDate(period.until),
          certificate_no: input.certificate_no || null,
        },
        `登记资格: ${getServiceTypeName(input.service_type)}`,
      ]
    );

    await client.query('COMMIT');
    return { success: true, message: messages.qualifications.issued, data: qualification };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('登记资格失败', error);
    return { success: false, error: messages.admin.operationFailed };
  } finally {
    client.release();
  }
};

export const renewQualification = async (
  volunteerId: string,
  input: QualificationInput,
  adminId: string
): Promise<ApiResponse<any>> => {
  if (!SERVICE_TYPE_WEIGHTS.some(t => t.type === input.service_type)) {
    return { success: false, error: messages.qualifications.invalidType };
  }
  if (!isQualificationRequired(input.service_type)) {
    return { success: false, error: messages.qualifications.typeNotRequired };
  }
  const period = validatePeriod(input);
  if (!period) {
    return { success: false, error: messages.qualifications.invalidDateRange };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query('SELECT id FROM volunteers WHERE id = $1', [volunteerId]);
    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    // 旧资格先按到期归档；若当前有效资格已自然到期，则不存在可续期对象
    await archiveExpired(client, volunteerId, input.service_type);
    const current = await getActiveQualification(client, volunteerId, input.service_type);
    if (!current) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.noActiveToRenew };
    }

    // 旧资格留档为 renewed，不再可能被核验命中
    await client.query(
      `UPDATE volunteer_qualifications SET status = 'renewed' WHERE id = $1`,
      [current.id]
    );

    const insertResult = await client.query(
      `INSERT INTO volunteer_qualifications
         (volunteer_id, service_type, status, valid_from, valid_until, certificate_no, issued_by, renewed_from)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
       RETURNING *`,
      [volunteerId, input.service_type, period.from, period.until, input.certificate_no, adminId, current.id]
    );
    const qualification = insertResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'qualification_renew', 'volunteer_qualification', $2, $3, $4, $5)`,
      [
        adminId,
        qualification.id,
        { id: current.id, valid_from: formatDate(current.valid_from), valid_until: formatDate(current.valid_until) },
        {
          volunteer_id: volunteerId,
          service_type: input.service_type,
          valid_from: formatDate(period.from),
          valid_until: formatDate(period.until),
          certificate_no: input.certificate_no || null,
        },
        `资格续期: ${getServiceTypeName(input.service_type)}`,
      ]
    );

    await client.query('COMMIT');
    return {
      success: true,
      message: messages.qualifications.renewed,
      data: { qualification, previous: current },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('资格续期失败', error);
    return { success: false, error: messages.admin.operationFailed };
  } finally {
    client.release();
  }
};

export const revokeQualification = async (
  qualificationId: string,
  adminId: string,
  reason: string
): Promise<ApiResponse<Qualification>> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT * FROM volunteer_qualifications WHERE id = $1 FOR UPDATE',
      [qualificationId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.notFound };
    }
    const current = result.rows[0] as Qualification;
    if (current.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.noActiveToRevoke };
    }

    const updateResult = await client.query(
      `UPDATE volunteer_qualifications
         SET status = 'revoked', revoked_by = $1, revoked_at = CURRENT_TIMESTAMP, revoke_reason = $2
       WHERE id = $3
       RETURNING *`,
      [adminId, reason, qualificationId]
    );
    const revoked = updateResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'qualification_revoke', 'volunteer_qualification', $2, $3, $4, $5)`,
      [
        adminId,
        qualificationId,
        { status: current.status, valid_until: formatDate(current.valid_until) },
        { status: 'revoked', revoked_at: revoked.revoked_at },
        reason,
      ]
    );

    await client.query('COMMIT');
    // 撤销立即生效：status 已不是 active，任何服务日期的核验都不会命中
    return { success: true, message: messages.qualifications.revoked, data: revoked };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('撤销资格失败', error);
    return { success: false, error: messages.admin.operationFailed };
  } finally {
    client.release();
  }
};

export const getVolunteerQualifications = async (
  volunteerId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();
  try {
    const volunteerResult = await client.query('SELECT id FROM volunteers WHERE id = $1', [volunteerId]);
    if (volunteerResult.rows.length === 0) {
      return { success: false, error: messages.volunteers.notFound };
    }

    const allResult = await client.query(
      `SELECT * FROM volunteer_qualifications
       WHERE volunteer_id = $1
       ORDER BY service_type, created_at DESC`,
      [volunteerId]
    );
    const all = allResult.rows as Qualification[];

    // 当前资格：active 且未自然到期（含尚未到生效日的已登记资格，以 effective_now 标识）
    const currentResult = await client.query(
      `SELECT *,
              (valid_from::date <= CURRENT_DATE) AS effective_now
       FROM volunteer_qualifications
       WHERE volunteer_id = $1
         AND status = 'active'
         AND valid_until::date >= CURRENT_DATE
       ORDER BY service_type`,
      [volunteerId]
    );

    return {
      success: true,
      data: {
        current: currentResult.rows,
        history: all,
      },
    };
  } finally {
    client.release();
  }
};

/** 仅查询当前有效资格（供志愿者详情使用） */
export const getCurrentQualifications = async (
  client: PoolClient,
  volunteerId: string
): Promise<Qualification[]> => {
  const result = await client.query(
    `SELECT *,
            (valid_from::date <= CURRENT_DATE) AS effective_now
     FROM volunteer_qualifications
     WHERE volunteer_id = $1
       AND status = 'active'
       AND valid_until::date >= CURRENT_DATE
     ORDER BY service_type`,
    [volunteerId]
  );
  return result.rows as Qualification[];
};

/**
 * 在给定事务连接上，按服务日期核验志愿者对该服务类型的资格。
 * 不需要资格的类型直接放行。
 */
export const verifyServiceQualification = async (
  client: PoolClient,
  volunteerId: string,
  serviceType: string,
  serviceDate: Date | string
): Promise<{ ok: true } | { ok: false; violation: Omit<QualificationViolation, 'volunteer_name'> }> => {
  if (!isQualificationRequired(serviceType)) {
    return { ok: true };
  }

  // 只取 active 资格（每类型至多一份），具体日期判定交给纯函数以区分未生效/已到期
  const result = await client.query(
    `SELECT * FROM volunteer_qualifications
     WHERE volunteer_id = $1 AND service_type = $2 AND status = 'active'
     LIMIT 1`,
    [volunteerId, serviceType]
  );
  const active = result.rows[0] as Qualification | undefined;

  const check = evaluateQualification(active, serviceDate);
  if (check.valid) {
    return { ok: true };
  }

  const reason = describeReason(serviceType, check, active);

  return {
    ok: false,
    violation: {
      volunteer_id: volunteerId,
      service_type: serviceType,
      service_date: formatDate(serviceDate),
      reason,
    },
  };
};

interface RecordLike {
  volunteer_id: string;
  service_type: string;
  recorded_at?: Date | string;
}

/**
 * 批量预检：志愿者必须存在，且在各自服务日期具备所需资格。
 * 任一不符即返回违规清单，调用方据此整批拒绝，不做任何写入。
 */
export const preflightBatchRecords = async (
  client: PoolClient,
  records: RecordLike[]
): Promise<QualificationViolation[]> => {
  const violations: QualificationViolation[] = [];
  const nameCache = new Map<string, string | null>();

  for (const record of records) {
    const serviceDate = record.recorded_at ? new Date(record.recorded_at) : new Date();

    let volunteerName: string | null;
    const cached = nameCache.get(record.volunteer_id);
    if (cached === undefined) {
      const volunteerResult = await client.query(
        'SELECT name FROM volunteers WHERE id = $1',
        [record.volunteer_id]
      );
      volunteerName = volunteerResult.rows[0]?.name || null;
      nameCache.set(record.volunteer_id, volunteerName);
    } else {
      volunteerName = cached;
    }

    if (!volunteerName) {
      violations.push({
        volunteer_id: record.volunteer_id,
        service_type: record.service_type,
        service_date: formatDate(serviceDate),
        reason: messages.volunteers.notFound,
      });
      continue;
    }
    const check = await verifyServiceQualification(client, record.volunteer_id, record.service_type, serviceDate);
    if (!check.ok) {
      violations.push({ ...check.violation, volunteer_name: volunteerName });
    }
  }

  return violations;
};

/** 供服务记录单条创建复用：将记录归一成可核验形态 */
export const recordServiceDate = (record: ServiceRecord): Date =>
  record.recorded_at ? new Date(record.recorded_at) : new Date();

/**
 * 排班预检：不落库、不改变任何数据，仅按服务日期核对资格。
 * 返回全部不满足项（人员+类型+日期+原因），供排班前拦截。
 */
export const checkScheduleEligibility = async (
  items: RecordLike[]
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();
  try {
    const violations = await preflightBatchRecords(client, items.map(i => ({ ...i })));
    return {
      success: true,
      data: {
        eligible: violations.length === 0,
        checked: items.length,
        violations: violations.map(v => ({ ...v, service_type_name: getServiceTypeName(v.service_type) })),
      },
    };
  } finally {
    client.release();
  }
};
