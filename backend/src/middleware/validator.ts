import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { messages } from '../constants/messages';

export const validateRequest = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body);

    if (error) {
      res.status(400).json({
        success: false,
        error: messages.validation.invalidBody,
        details: error.details.map(d => d.message),
      });
      return;
    }

    req.body = value;
    next();
  };
};

export const validateQuery = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.query);

    if (error) {
      res.status(400).json({
        success: false,
        error: messages.validation.invalidQuery,
        details: error.details.map(d => d.message),
      });
      return;
    }

    req.query = value;
    next();
  };
};

export const serviceRecordSchema = Joi.object({
  volunteer_id: Joi.string().uuid().required(),
  service_type: Joi.string().valid(
    'elderly_care', 'child_care', 'medical_assist', 'education',
    'community_service', 'disaster_relief', 'environmental',
    'cultural_activity', 'other'
  ).required(),
  duration_hours: Joi.number().positive().required(),
  rating: Joi.number().integer().min(1).max(5).default(5),
  is_no_show: Joi.boolean().default(false),
  location: Joi.string().optional(),
  description: Joi.string().optional(),
  recorded_at: Joi.date().optional(),
});

export const batchServiceRecordsSchema = Joi.object({
  records: Joi.array().items(serviceRecordSchema).min(1).required(),
});

export const volunteerCreateSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  phone: Joi.string().pattern(/^1[3-9]\d{9}$/).optional(),
  email: Joi.string().email().optional(),
});

export const volunteerUpdateSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  phone: Joi.string().pattern(/^1[3-9]\d{9}$/).optional(),
  email: Joi.string().email().optional(),
});

export const complaintSchema = Joi.object({
  volunteer_id: Joi.string().uuid().required(),
  complaint_type: Joi.string().valid(
    'no_show', 'poor_attitude', 'violation', 'misconduct', 'other'
  ).required(),
  description: Joi.string().min(5).required(),
  complainant_id: Joi.string().uuid().optional(),
});

export const handleComplaintSchema = Joi.object({
  action: Joi.string().valid('resolve', 'reject').required(),
  resolution: Joi.string().min(5).required(),
  severity: Joi.number().integer().min(1).max(3).default(1),
});

export const adjustPointsSchema = Joi.object({
  volunteer_id: Joi.string().uuid().required(),
  points_change: Joi.number().integer().required(),
  reason: Joi.string().min(5).required(),
});

export const adjustCreditSchema = Joi.object({
  volunteer_id: Joi.string().uuid().required(),
  credit_change: Joi.number().integer().min(-50).max(50).required(),
  reason: Joi.string().min(5).required(),
});

export const issueQualificationSchema = Joi.object({
  volunteer_id: Joi.string().uuid().required(),
  service_type: Joi.string().valid(
    'elderly_care', 'child_care', 'medical_assist', 'education',
    'community_service', 'disaster_relief', 'environmental',
    'cultural_activity', 'other'
  ).required(),
  valid_from: Joi.date().optional(),
  valid_until: Joi.date().required().messages({ 'any.required': '缺少有效期到期日' }),
  note: Joi.string().max(500).optional(),
}).custom((value, helpers) => {
  const from = value.valid_from ? new Date(value.valid_from) : new Date();
  if (new Date(value.valid_until) < new Date(from.toDateString())) {
    return helpers.error('date.greater', { label: 'valid_until' });
  }
  return value;
}).messages({ 'date.greater': '有效期到期日不能早于起始日' });

export const renewQualificationSchema = Joi.object({
  valid_until: Joi.date().required().messages({ 'any.required': '缺少续期后的到期日' }),
  note: Joi.string().max(500).optional(),
});

export const revokeQualificationSchema = Joi.object({
  reason: Joi.string().min(2).max(500).required().messages({
    'string.min': '撤销原因不能少于2个字符',
  }),
});

export const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().optional(),
});

export const trendSchema = Joi.object({
  start_date: Joi.date().required(),
  end_date: Joi.date().required(),
});
