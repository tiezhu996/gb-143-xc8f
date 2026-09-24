import { PoolClient } from 'pg';
import { Qualification, QualificationViolation, ServiceRecord, QUALIFICATION_REQUIRED_TYPES } from '../types';
import pool from '../db/pool';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

// 将入参日期统一为 YYYY-MM-DD
export const toDateString = (date: Date | string): string => {
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date; // DATE 列经 pg 类型解析后已是 YYYY-MM-DD
    }
    return new Date(date).toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
};

export const isQualificationRequired = (serviceType: string): boolean =>
  QUALIFICATION_REQUIRED_TYPES.includes(serviceType);

// 将已过有效期的 active 资格标记为 expired
const markExpired = async (client: PoolClient): Promise<void> => {
  await client.query(
    `UPDATE volunteer_qualifications
     SET status = 'expired'
     WHERE status = 'active' AND valid_until < CURRENT_DATE`
  );
};

const getServiceDateString = (record: Partial<ServiceRecord>): string =>
  record.recorded_at ? toDateString(record.recorded_at) : new Date().toISOString().slice(0, 10);

/**
 * 判断志愿者在指定服务日期是否持有该类型的有效资格。
 * 同一类型只保留一份有效资格；续期产生的旧资格（renewed）留档，
 * 在其自身有效期内仍可用于历史日期补录；撤销（revoked）当日起立即失效，
 * 且撤销日之后旧资格也不再使其有效。
 */
export const evaluateQualificationAtDate = (
  rows: Qualification[],
  serviceDate: string
): { valid: boolean; reason?: string; qualification?: Qualification } => {
  if (rows.length === 0) {
    return { valid: false, reason: messages.qualifications.missing };
  }

  const latest = rows.reduce((a, b) =>
    new Date(a.created_at).getTime() >= new Date(b.created_at).getTime() ? a : b
  );
  const intervalContains = (q: Qualification): boolean =>
    toDateString(q.valid_from) <= serviceDate && toDateString(q.valid_until) >= serviceDate;

  // 撤销具有覆盖性：最新资格一旦撤销，撤销当日（按日）及之后一律不通过；
  // 严格早于撤销日的历史服务仍可用旧资格补录
  if (
    latest.status === 'revoked' &&
    latest.revoked_at !== undefined &&
    latest.revoked_at !== null &&
    toDateString(latest.revoked_at) <= serviceDate
  ) {
    return { valid: false, reason: messages.qualifications.revokedAtServiceDate };
  }
  // 未被撤销覆盖时，任一资格在其有效期内即可：
  // renewed/expired 为续期留档；revoked 行在撤销日之前的历史区间仍可用于补录
  const covering = rows.find(q => {
    if (!intervalContains(q)) {
      return false;
    }
    if (q.status !== 'revoked') {
      return true;
    }
    return (
      q.revoked_at !== undefined &&
      q.revoked_at !== null &&
      serviceDate < toDateString(q.revoked_at)
    );
  });
  if (covering) {
    return { valid: true, qualification: covering };
  }

  if (toDateString(latest.valid_from) > serviceDate) {
    return { valid: false, reason: messages.qualifications.notYetValid };
  }
  if (toDateString(latest.valid_until) < serviceDate) {
    return { valid: false, reason: messages.qualifications.expired };
  }

  return { valid: false, reason: messages.qualifications.missing };
};

// 可在外部事务中复用的单条核验
export const checkQualificationForRecord = async (
  client: PoolClient,
  volunteerId: string,
  serviceType: string,
  serviceDate: string
): Promise<{ valid: boolean; reason?: string }> => {
  if (!isQualificationRequired(serviceType)) {
    return { valid: true };
  }

  const result = await client.query(
    'SELECT * FROM volunteer_qualifications WHERE volunteer_id = $1 AND service_type = $2',
    [volunteerId, serviceType]
  );

  return evaluateQualificationAtDate(result.rows as Qualification[], serviceDate);
};

interface IssueQualificationInput {
  volunteerId: string;
  serviceType: string;
  validUntil: string;
  validFrom?: string;
  adminId: string;
  note?: string;
}

export const issueQualification = async (
  input: IssueQualificationInput
): Promise<{ success: boolean; error?: string; data?: Qualification; message?: string }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await markExpired(client);

    const volunteerResult = await client.query(
      'SELECT id FROM volunteers WHERE id = $1',
      [input.volunteerId]
    );
    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const activeResult = await client.query(
      `SELECT * FROM volunteer_qualifications
       WHERE volunteer_id = $1 AND service_type = $2 AND status = 'active'`,
      [input.volunteerId, input.serviceType]
    );
    if (activeResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.activeExists };
    }

    const insertResult = await client.query(
      `INSERT INTO volunteer_qualifications
         (volunteer_id, service_type, valid_from, valid_until, issued_by, issue_note)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::date, $5, $6)
       RETURNING *`,
      [
        input.volunteerId,
        input.serviceType,
        input.validFrom || null,
        input.validUntil,
        input.adminId,
        input.note || null,
      ]
    );
    const qualification = insertResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, 'issue_qualification', 'qualification', $2, $3, $4)`,
      [input.adminId, qualification.id, qualification, input.note || '管理员登记资格']
    );

    await client.query('COMMIT');
    return { success: true, data: qualification, message: messages.qualifications.issued };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.issueQualificationFailed, error);
    return { success: false, error: messages.qualifications.issueFailed };
  } finally {
    client.release();
  }
};

interface RenewQualificationInput {
  qualificationId: string;
  validUntil: string;
  adminId: string;
  note?: string;
}

// 续期：旧资格置为 renewed 留档，新资格紧接旧有效期生效，同类型仍只有一份 active
export const renewQualification = async (
  input: RenewQualificationInput
): Promise<{ success: boolean; error?: string; data?: { old: Qualification; current: Qualification }; message?: string }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await markExpired(client);

    const oldResult = await client.query(
      'SELECT * FROM volunteer_qualifications WHERE id = $1 FOR UPDATE',
      [input.qualificationId]
    );
    if (oldResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.notFound };
    }

    const old = oldResult.rows[0] as Qualification;
    if (old.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.notActive };
    }

    const archivedResult = await client.query(
      `UPDATE volunteer_qualifications
       SET status = 'renewed'
       WHERE id = $1
       RETURNING *`,
      [input.qualificationId]
    );
    const archived = archivedResult.rows[0] as Qualification;

    const insertResult = await client.query(
      `INSERT INTO volunteer_qualifications
         (volunteer_id, service_type, valid_from, valid_until, issued_by, issue_note, renewed_from_id)
       VALUES ($1, $2, ($3::date + INTERVAL '1 day')::date, $4::date, $5, $6, $7)
       RETURNING *`,
      [
        old.volunteer_id,
        old.service_type,
        toDateString(old.valid_until),
        input.validUntil,
        input.adminId,
        input.note || null,
        old.id,
      ]
    );
    const current = insertResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'renew_qualification', 'qualification', $2, $3, $4, $5)`,
      [input.adminId, current.id, archived, current, input.note || '管理员续期资格，旧资格留档']
    );

    await client.query('COMMIT');
    return { success: true, data: { old: archived, current }, message: messages.qualifications.renewed };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.renewQualificationFailed, error);
    return { success: false, error: messages.qualifications.renewFailed };
  } finally {
    client.release();
  }
};

interface RevokeQualificationInput {
  qualificationId: string;
  adminId: string;
  reason: string;
}

// 撤销：active 资格立即失效并留档
export const revokeQualification = async (
  input: RevokeQualificationInput
): Promise<{ success: boolean; error?: string; data?: Qualification; message?: string }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await markExpired(client);

    const existingResult = await client.query(
      'SELECT * FROM volunteer_qualifications WHERE id = $1 FOR UPDATE',
      [input.qualificationId]
    );
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.notFound };
    }

    const existing = existingResult.rows[0] as Qualification;
    if (existing.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.qualifications.notActive };
    }

    const revokeResult = await client.query(
      `UPDATE volunteer_qualifications
       SET status = 'revoked',
           revoked_at = CURRENT_TIMESTAMP,
           revoked_by = $1,
           revoke_reason = $2
       WHERE id = $3
       RETURNING *`,
      [input.adminId, input.reason, input.qualificationId]
    );
    const revoked = revokeResult.rows[0] as Qualification;

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'revoke_qualification', 'qualification', $2, $3, $4, $5)`,
      [input.adminId, input.qualificationId, existing, revoked, input.reason]
    );

    await client.query('COMMIT');
    return { success: true, data: revoked, message: messages.qualifications.revoked };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.revokeQualificationFailed, error);
    return { success: false, error: messages.qualifications.revokeFailed };
  } finally {
    client.release();
  }
};

// 志愿者详情：当前有效资格 + 历史留档
export const getVolunteerQualifications = async (
  volunteerId: string
): Promise<{ success: boolean; error?: string; data?: { current: Qualification[]; history: Qualification[] } }> => {
  const client = await pool.connect();

  try {
    await markExpired(client);

    const result = await client.query(
      `SELECT * FROM volunteer_qualifications
       WHERE volunteer_id = $1
       ORDER BY
         CASE status WHEN 'active' THEN 0 ELSE 1 END,
         updated_at DESC,
         created_at DESC`,
      [volunteerId]
    );

    const rows = result.rows as Qualification[];
    return {
      success: true,
      data: {
        current: rows.filter(q => q.status === 'active'),
        history: rows.filter(q => q.status !== 'active'),
      },
    };
  } finally {
    client.release();
  }
};

/**
 * 录入前资格核验（供批量整批拒绝使用）：
 * 按每条记录的服务日期核对本人当时资格；志愿者不存在同样判为不通过。
 */
export const findQualificationViolations = async (
  records: ServiceRecord[]
): Promise<QualificationViolation[]> => {
  const client = await pool.connect();

  try {
    const volunteerIds = [...new Set(records.map(r => r.volunteer_id))];
    const volunteersResult = await client.query(
      'SELECT id, name FROM volunteers WHERE id = ANY($1::uuid[])',
      [volunteerIds]
    );
    const nameMap = new Map<string, string>(
      volunteersResult.rows.map((r: { id: string; name: string }) => [r.id, r.name])
    );

    const requiredRecords = records.filter(r => isQualificationRequired(r.service_type));
    const pairs = new Map<string, { volunteerId: string; serviceType: string; serviceDate: string }>();
    for (const record of requiredRecords) {
      const serviceDate = getServiceDateString(record);
      const key = `${record.volunteer_id}|${record.service_type}|${serviceDate}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          volunteerId: record.volunteer_id,
          serviceType: record.service_type,
          serviceDate,
        });
      }
    }

    const violations: QualificationViolation[] = [];
    const seenMissingVolunteers = new Set<string>();

    for (const { volunteerId, serviceType, serviceDate } of pairs.values()) {
      const name = nameMap.get(volunteerId);
      if (!name) {
        if (!seenMissingVolunteers.has(volunteerId)) {
          seenMissingVolunteers.add(volunteerId);
          violations.push({
            volunteer_id: volunteerId,
            service_type: serviceType,
            reason: messages.volunteers.notFound,
            service_date: serviceDate,
          });
        }
        continue;
      }

      const qualResult = await client.query(
        'SELECT * FROM volunteer_qualifications WHERE volunteer_id = $1 AND service_type = $2',
        [volunteerId, serviceType]
      );
      const evaluation = evaluateQualificationAtDate(qualResult.rows as Qualification[], serviceDate);
      if (!evaluation.valid) {
        violations.push({
          volunteer_id: volunteerId,
          volunteer_name: name,
          service_type: serviceType,
          reason: evaluation.reason || messages.qualifications.missing,
          service_date: serviceDate,
        });
      }
    }

    return violations;
  } finally {
    client.release();
  }
};
