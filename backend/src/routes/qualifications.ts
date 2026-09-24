import { Router, Response } from 'express';
import { validateRequest, qualificationIssueSchema, qualificationRenewSchema, qualificationRevokeSchema, eligibilityCheckSchema } from '../middleware/validator';
import { AuthRequest } from '../middleware/auth';
import {
  issueQualification,
  renewQualification,
  revokeQualification,
  getVolunteerQualifications,
  checkScheduleEligibility,
} from '../services/qualificationService';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

// 排班预检：按服务日期核对资格，不落库
router.post('/check', validateRequest(eligibilityCheckSchema), async (req: AuthRequest, res: Response) => {
  try {
    const items = (req.body.items as Array<{ volunteer_id: string; service_type: string; service_date: string }>)
      .map(i => ({ volunteer_id: i.volunteer_id, service_type: i.service_type, recorded_at: i.service_date }));
    const result = await checkScheduleEligibility(items);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error checking schedule eligibility');
  }
});

// 登记资格（同一类型已有有效资格时拒绝，引导走续期）
router.post(
  '/volunteers/:volunteerId/issue',
  validateRequest(qualificationIssueSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const adminId = req.user?.id || 'admin';
      const result = await issueQualification(req.params.volunteerId, req.body, adminId);
      const statusCode = result.success ? 201 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      sendInternalError(res, error, 'Error issuing qualification');
    }
  }
);

// 续期：旧资格留档为 renewed，新资格生效
router.post(
  '/volunteers/:volunteerId/renew',
  validateRequest(qualificationRenewSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const adminId = req.user?.id || 'admin';
      const result = await renewQualification(req.params.volunteerId, req.body, adminId);
      const statusCode = result.success ? 200 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      sendInternalError(res, error, 'Error renewing qualification');
    }
  }
);

// 撤销：立即失效（status -> revoked）
router.post(
  '/:id/revoke',
  validateRequest(qualificationRevokeSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const adminId = req.user?.id || 'admin';
      const result = await revokeQualification(req.params.id, adminId, req.body.reason);
      const statusCode = result.success ? 200 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      sendInternalError(res, error, 'Error revoking qualification');
    }
  }
);

// 查询某志愿者的全部资格留档
router.get('/volunteers/:volunteerId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getVolunteerQualifications(req.params.volunteerId);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting qualifications');
  }
});

export default router;
