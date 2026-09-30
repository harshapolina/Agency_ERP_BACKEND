import { Referral, Referrer, ReferralActivity, Lead, LeadCategory } from '../../../models/index.js';
import { REFERRAL_PROJECT_TYPES, TIER_BONUS, REFERRAL_STAGES } from '../../../shared/constants/os.js';
import { NotFoundError, ValidationError } from '../../../shared/errors/index.js';
import { logActivity, type Actor } from '../../../shared/os/activity.js';
import { oid } from '../../../shared/utils/crud.js';

export function tierFromCount(n: number) {
  if (n >= 6) return 'elite_partner';
  if (n >= 3) return 'growth_partner';
  return 'standard';
}

export function calculateReward(projectType: string, winsIncludingThis: number) {
  const tier = tierFromCount(winsIncludingThis);
  const base = REFERRAL_PROJECT_TYPES.find((p) => p.value === projectType)?.baseReward ?? 3000;
  const bonus = TIER_BONUS[tier] ?? 0;
  return { tier, base, bonus, rewardAmount: Math.round(base * (1 + bonus)) };
}

export function generateReferralCode(fullName: string, phone = '') {
  const letters = fullName.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
  const digits = phone.replace(/\D/g, '');
  const tail = digits.length >= 4 ? digits.slice(-4) : String(1000 + Math.floor(Math.random() * 9000));
  return `${letters}${tail}`;
}

export async function createUniqueReferralCode(organizationId: string, fullName: string, phone = '') {
  const base = generateReferralCode(fullName, phone);
  for (let i = 0; i < 10; i++) {
    const code = i === 0 ? base : `${base.slice(0, 4)}${1000 + Math.floor(Math.random() * 9000)}`;
    if (!(await Referrer.exists({ organizationId, referralCode: code }))) return code;
  }
  return `EDIT${Date.now().toString().slice(-6)}`;
}

export async function updateReferralStage(
  actor: Actor,
  referralId: string,
  input: { stage: string; projectType?: string; projectValue?: number; lostReason?: string; note?: string }
) {
  if (!(REFERRAL_STAGES as readonly string[]).includes(input.stage)) throw new ValidationError('Invalid stage');
  const referral = await Referral.findOne({ _id: referralId, organizationId: actor.organizationId });
  if (!referral) throw new NotFoundError('Referral');
  const fromStage = referral.stage;

  referral.stage = input.stage;
  if (input.stage === 'lost') referral.lostReason = input.lostReason || referral.lostReason || 'other';
  if (input.note) {
    referral.adminInternalNotes = [referral.adminInternalNotes, input.note].filter(Boolean).join('\n---\n');
  }

  // A win is only rewarded once, even if the stage is toggled away from and back to "won".
  if (input.stage === 'won' && fromStage !== 'won' && referral.rewardStatus === 'not_applicable') {
    if (!input.projectType) throw new ValidationError('Project type is required to mark a referral as won');
    const referrer = await Referrer.findById(referral.referrerId);
    if (referrer) {
      const wins = (referrer.successfulReferralCount || 0) + 1;
      const reward = calculateReward(input.projectType, wins);
      referral.projectType = input.projectType;
      referral.projectValue = Number(input.projectValue) || 0;
      referral.rewardAmount = reward.rewardAmount;
      referral.rewardStatus = 'pending';
      referral.convertedAt = new Date();
      referrer.successfulReferralCount = wins;
      referrer.tier = reward.tier;
      referrer.totalRewardEarned = (referrer.totalRewardEarned || 0) + reward.rewardAmount;
      await referrer.save();
      await ReferralActivity.create({
        organizationId: actor.organizationId, referralId: referral._id, eventType: 'reward_calculated',
        note: `Reward ₹${reward.rewardAmount} (${reward.tier})`, createdBy: actor.email,
      });
    }
  }
  referral.updatedBy = actor.email;
  await referral.save();

  if (fromStage !== input.stage) {
    await ReferralActivity.create({
      organizationId: actor.organizationId, referralId: referral._id, eventType: 'stage_change',
      fromStage, toStage: input.stage, note: input.note || '', createdBy: actor.email,
    });
  }
  await logActivity(actor, { title: `Referral stage → ${input.stage}`, detail: referral.referredName, entityType: 'referral', entityId: referralId });
  return referral.toObject();
}

export async function markRewardPaid(actor: Actor, referralId: string) {
  const referral = await Referral.findOne({ _id: referralId, organizationId: actor.organizationId });
  if (!referral) throw new NotFoundError('Referral');
  if (referral.rewardStatus !== 'pending') throw new ValidationError('Only pending rewards can be marked paid');
  referral.rewardStatus = 'paid';
  referral.rewardPaidAt = new Date();
  await referral.save();
  await Referrer.updateOne({ _id: referral.referrerId }, { $inc: { totalRewardPaid: referral.rewardAmount || 0 } });
  await ReferralActivity.create({
    organizationId: actor.organizationId, referralId: referral._id, eventType: 'reward_paid',
    note: `Reward ₹${referral.rewardAmount} paid`, createdBy: actor.email,
  });
  await logActivity(actor, { title: 'Referral reward paid', detail: referral.referredName, entityType: 'referral', entityId: referralId });
  return referral.toObject();
}

export async function promoteReferralToLead(actor: Actor, referralId: string) {
  const org = oid(actor.organizationId);
  const referral = await Referral.findOne({ _id: referralId, organizationId: org });
  if (!referral) throw new NotFoundError('Referral');
  if (referral.leadId) return { leadId: String(referral.leadId), existing: true };
  const category = await LeadCategory.findOne({ organizationId: org, isActive: true }).sort({ createdAt: 1 });
  if (!category) throw new ValidationError('Create a lead list first');
  const [firstName, ...rest] = referral.referredName.split(/\s+/);
  const lead = await Lead.create({
    organizationId: org, categoryId: category._id, firstName, lastName: rest.join(' '), email: referral.referredEmail,
    phone: referral.referredPhone, company: referral.referredBusiness, source: 'referral', requirement: referral.referredNeeds,
    referralId: referral._id, createdBy: actor.userId,
  });
  await LeadCategory.updateOne({ _id: category._id }, { $inc: { leadCount: 1 } });
  referral.leadId = lead._id;
  await referral.save();
  await logActivity(actor, { title: 'Referral promoted to lead', detail: referral.referredName, entityType: 'referral', entityId: referralId, leadId: String(lead._id) });
  return { leadId: String(lead._id), existing: false };
}

export function computeEGAScore(a: Record<string, unknown>) {
  const networkMap: Record<string, number> = { '0': 0, '1–5': 5, '6–10': 10, '11–25': 15, '25–50': 18, '50+': 20 };
  const hoursMap: Record<string, number> = { '1–3 hours': 2, '3–5 hours': 5, '5–10 hours': 8, '10+ hours': 10 };
  const durationMap: Record<string, number> = {
    'Less than 3 months': 2, '3–6 months': 5, '6–12 months': 7, '1+ year': 9, 'I want to build a long-term association': 10,
  };
  const scale = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 0;
  };
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const text = (v: unknown) => String(v ?? '').trim();
  const paragraphs = [a.about, a.whySelect, a.websiteObjection, a.rejectionResponse].map((p) => text(p).length);
  const avgChars = paragraphs.reduce((s, n) => s + n, 0) / paragraphs.length;

  const breakdown = {
    networkSize: networkMap[text(a.networkSize)] ?? 0,
    networkDiversity: Math.min(10, arr(a.industries).length),
    salesExperience: text(a.soldBefore) === 'Yes' ? 10 + (text(a.salesExperience) ? 5 : 0) : 0,
    comfort: Math.min(15, scale(a.comfortApproach) + scale(a.comfortColdCall) + scale(a.comfortOutreach)),
    commitmentHours: hoursMap[text(a.weeklyHours)] ?? 0,
    longTermIntent: durationMap[text(a.duration)] ?? 0,
    interestsBreadth: Math.round((Math.min(3, arr(a.interests).length) / 3) * 5),
    paragraphDepth: Math.min(15, Math.round((avgChars / 100) * 15 * 10) / 10),
  };
  const score = Math.min(100, Math.round(Object.values(breakdown).reduce((s, n) => s + n, 0)));
  return { score, breakdown };
}
