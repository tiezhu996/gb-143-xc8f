export const serviceTypes = [
  { type: 'elderly_care', name: '老人陪护', weight: 1.5, requires_qualification: false },
  { type: 'child_care', name: '儿童关爱', weight: 1.4, requires_qualification: false },
  { type: 'medical_assist', name: '医疗辅助', weight: 1.6, requires_qualification: true },
  { type: 'education', name: '教育辅导', weight: 1.3, requires_qualification: false },
  { type: 'community_service', name: '社区服务', weight: 1.2, requires_qualification: false },
  { type: 'disaster_relief', name: '救灾援助', weight: 2.0, requires_qualification: true },
  { type: 'environmental', name: '环保行动', weight: 1.1, requires_qualification: false },
  { type: 'cultural_activity', name: '文化活动', weight: 1.0, requires_qualification: false },
  { type: 'other', name: '其他服务', weight: 1.0, requires_qualification: false },
];

// 需要先登记有效资格才能录入服务记录的类型
export const qualificationRequiredTypes: string[] = serviceTypes
  .filter(t => t.requires_qualification)
  .map(t => t.type);

export const isQualificationRequired = (serviceType: string): boolean =>
  qualificationRequiredTypes.includes(serviceType);

export const badgeLevels = [
  { level: 1, name: '一星志愿者', points_required: 0 },
  { level: 2, name: '二星志愿者', points_required: 100 },
  { level: 3, name: '三星志愿者', points_required: 300 },
  { level: 4, name: '四星志愿者', points_required: 600 },
  { level: 5, name: '五星志愿者', points_required: 1000 },
];

export const serviceRules = {
  pointsPerHour: 10,
  creditLimitThreshold: 30,
};

export const apiEndpoints = [
  'GET  /health - 健康检查',
  'GET  /api/v1/service-types - 服务类型配置',
  'POST /api/v1/volunteers - 创建志愿者',
  'GET  /api/v1/volunteers/:id - 获取志愿者信息',
  'GET  /api/v1/volunteers/:id/summary - 志愿者汇总（含当前资格）',
  'GET  /api/v1/volunteers/:id/badges - 徽章列表',
  'GET  /api/v1/volunteers/:id/qualifications - 资格列表与留档',
  'GET  /api/v1/volunteers/:id/points-logs - 积分明细',
  'GET  /api/v1/volunteers/:id/credit-logs - 信用明细',
  'POST /api/v1/service-records - 创建服务记录（按服务日期核验资格）',
  'POST /api/v1/service-records/batch - 批量导入（资格不符整批拒绝）',
  'GET  /api/v1/ranking/points - 积分排行榜',
  'GET  /api/v1/ranking/credit - 信用排行榜',
  'GET  /api/v1/ranking/trend - 趋势数据',
  'POST /api/v1/complaints - 创建投诉',
  'POST /api/v1/complaints/:id/handle - 处理投诉',
  'POST /api/v1/admin/adjust-points - 调整积分',
  'POST /api/v1/admin/adjust-credit - 调整信用分',
  'POST /api/v1/admin/qualifications/volunteers/:volunteerId/issue - 登记资格',
  'POST /api/v1/admin/qualifications/volunteers/:volunteerId/renew - 资格续期（旧资格留档）',
  'POST /api/v1/admin/qualifications/:id/revoke - 撤销资格（立即失效）',
  'POST /api/v1/admin/qualifications/check - 排班资格预检（按服务日期，不落库）',
  'GET  /api/v1/admin/qualifications/volunteers/:volunteerId - 查询资格留档',
];
