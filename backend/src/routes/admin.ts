import { Router, Response } from 'express';
import {
  validateRequest,
  validateQuery,
  adjustPointsSchema,
  adjustCreditSchema,
  paginationSchema,
  issueQualificationSchema,
  renewQualificationSchema,
  revokeQualificationSchema,
} from '../middleware/validator';
import {
  adjustPoints,
  adjustCreditScore,
  getAdminAuditLogs,
  setVolunteerStatus,
} from '../services/adminService';
import {
  issueQualification,
  renewQualification,
  revokeQualification,
  toDateString,
} from '../services/qualificationService';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { messages } from '../constants/messages';
import { sendBadRequest, sendInternalError } from '../utils/httpResponses';

const router = Router();

router.use(requireAdmin);

router.post('/adjust-points', validateRequest(adjustPointsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustPoints(
      req.body.volunteer_id,
      req.body.points_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting points');
  }
});

router.post('/adjust-credit', validateRequest(adjustCreditSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustCreditScore(
      req.body.volunteer_id,
      req.body.credit_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting credit score');
  }
});

router.get('/audit-logs', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const adminId = req.query.admin_id as string;
    const action = req.query.action as string;
    const result = await getAdminAuditLogs(page, pageSize, adminId, action);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting audit logs');
  }
});

router.patch('/volunteers/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const isActive = req.body.is_active;
    if (typeof isActive !== 'boolean') {
      sendBadRequest(res, messages.validation.activeFlagRequired);
      return;
    }
    const adminId = req.user?.id || 'admin';
    const reason = req.body.reason || '管理员操作';
    const result = await setVolunteerStatus(req.params.id, isActive, adminId, reason);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error setting volunteer status');
  }
});

// 登记资格（按服务类型 + 有效期，同一类型仅一份有效资格）
router.post('/qualifications', validateRequest(issueQualificationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await issueQualification({
      volunteerId: req.body.volunteer_id,
      serviceType: req.body.service_type,
      validFrom: req.body.valid_from ? toDateString(req.body.valid_from) : undefined,
      validUntil: toDateString(req.body.valid_until),
      adminId,
      note: req.body.note,
    });
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error issuing qualification');
  }
});

// 续期资格（旧资格留档）
router.post('/qualifications/:id/renew', validateRequest(renewQualificationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await renewQualification({
      qualificationId: req.params.id,
      validUntil: toDateString(req.body.valid_until),
      adminId,
      note: req.body.note,
    });
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error renewing qualification');
  }
});

// 撤销资格（立即失效）
router.post('/qualifications/:id/revoke', validateRequest(revokeQualificationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await revokeQualification({
      qualificationId: req.params.id,
      adminId,
      reason: req.body.reason,
    });
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error revoking qualification');
  }
});

export default router;
