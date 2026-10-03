export type EgaFieldType = 'text' | 'email' | 'select' | 'multiselect' | 'scale' | 'textarea';

export interface EgaFormField {
  id: string;
  type: EgaFieldType;
  label: string;
  section: string;
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Points awarded per option value, or per selected item / scale point. */
  scoreMap?: Record<string, number>;
  maxScore?: number;
}

export interface EgaFormConfigShape {
  title: string;
  subtitle: string;
  published: boolean;
  fields: EgaFormField[];
}

const opt = (values: string[]) => values.map((v) => ({ value: v, label: v }));

/** Default Growth Associate form — companies can edit this in Growth → EGA. */
export const DEFAULT_EGA_FORM: EgaFormConfigShape = {
  title: 'Growth Associate programme',
  subtitle: 'Help local businesses grow with websites, automation and AI — and earn while you learn.',
  published: true,
  fields: [
    { id: 'fullName', type: 'text', label: 'Full name', section: 'About you', required: true },
    { id: 'email', type: 'email', label: 'Email', section: 'About you', required: true },
    { id: 'phone', type: 'text', label: 'Phone', section: 'About you' },
    { id: 'city', type: 'text', label: 'City', section: 'About you' },
    { id: 'college', type: 'text', label: 'College', section: 'About you' },
    { id: 'yearOfStudy', type: 'text', label: 'Year of study', section: 'About you' },
    { id: 'specialization', type: 'text', label: 'Specialisation', section: 'About you' },
    { id: 'about', type: 'textarea', label: 'Tell us about yourself', section: 'About you', maxScore: 5 },
    {
      id: 'interests', type: 'multiselect', label: 'Interests', section: 'About you',
      options: opt(['Sales', 'Marketing', 'Business development', 'Technology', 'Entrepreneurship']),
      maxScore: 5,
    },
    { id: 'linkedin', type: 'text', label: 'LinkedIn', section: 'About you', placeholder: 'https://linkedin.com/in/…' },
    {
      id: 'knowsOwners', type: 'select', label: 'Do you personally know business owners?', section: 'Your network',
      options: opt(['Yes', 'No', 'A few']),
      scoreMap: { Yes: 8, 'A few': 4, No: 0 },
    },
    {
      id: 'networkSize', type: 'select', label: 'How many business owners could you reach?', section: 'Your network',
      options: opt(['0', '1–5', '6–10', '11–25', '25–50', '50+']),
      scoreMap: { '0': 0, '1–5': 5, '6–10': 10, '11–25': 15, '25–50': 18, '50+': 20 },
    },
    {
      id: 'industries', type: 'multiselect', label: 'Industries you have access to', section: 'Your network',
      options: opt(['Restaurants & cafes', 'Retail', 'Healthcare', 'Education', 'Real estate', 'Salons & fitness', 'Professional services', 'Manufacturing']),
      maxScore: 10,
    },
    {
      id: 'networkSources', type: 'multiselect', label: 'Where does your network come from?', section: 'Your network',
      options: opt(['Family business', 'Friends & relatives', 'College network', 'Local community', 'Social media']),
    },
    {
      id: 'soldBefore', type: 'select', label: 'Have you sold anything before?', section: 'Sales',
      options: opt(['Yes', 'No']),
      scoreMap: { Yes: 10, No: 0 },
    },
    { id: 'salesExperience', type: 'textarea', label: 'Describe your sales experience', section: 'Sales', helpText: 'Shown when you have sold before', maxScore: 5 },
    { id: 'comfortApproach', type: 'scale', label: 'Comfort approaching business owners (1–5)', section: 'Sales', maxScore: 5 },
    { id: 'comfortColdCall', type: 'scale', label: 'Comfort with cold calls (1–5)', section: 'Sales', maxScore: 5 },
    { id: 'comfortOutreach', type: 'scale', label: 'Comfort with online outreach (1–5)', section: 'Sales', maxScore: 5 },
    { id: 'websiteObjection', type: 'textarea', label: 'An owner says "I don\'t need a website." What do you say?', section: 'Sales', maxScore: 5 },
    { id: 'rejectionResponse', type: 'textarea', label: 'How do you handle rejection?', section: 'Sales', maxScore: 5 },
    {
      id: 'services', type: 'multiselect', label: 'Services you would be most confident selling', section: 'Sales',
      options: opt(['Websites', 'CRM & automation', 'AI calling agents', 'Digital marketing']),
    },
    { id: 'exampleBusiness', type: 'textarea', label: 'A local business you think we could help, and why', section: 'Sales' },
    {
      id: 'weeklyHours', type: 'select', label: 'Hours per week', section: 'Commitment',
      options: opt(['1–3 hours', '3–5 hours', '5–10 hours', '10+ hours']),
      scoreMap: { '1–3 hours': 2, '3–5 hours': 5, '5–10 hours': 8, '10+ hours': 10 },
    },
    {
      id: 'duration', type: 'select', label: 'How long would you like to work with us?', section: 'Commitment',
      options: opt(['Less than 3 months', '3–6 months', '6–12 months', '1+ year', 'I want to build a long-term association']),
      scoreMap: { 'Less than 3 months': 2, '3–6 months': 5, '6–12 months': 7, '1+ year': 9, 'I want to build a long-term association': 10 },
    },
    { id: 'performanceBased', type: 'select', label: 'Open to performance-based pay?', section: 'Commitment', options: opt(['Yes', 'No', 'Maybe']) },
    { id: 'training', type: 'select', label: 'Willing to attend training?', section: 'Commitment', options: opt(['Yes', 'No']) },
    { id: 'whySelect', type: 'textarea', label: 'Why should we select you?', section: 'Commitment', maxScore: 5 },
    { id: 'anythingElse', type: 'textarea', label: 'Anything else?', section: 'Commitment' },
  ],
};

export function scoreEgaAnswers(fields: EgaFormField[], answers: Record<string, unknown>) {
  const breakdown: Record<string, number> = {};
  for (const field of fields) {
    const raw = answers[field.id];
    let pts = 0;
    if (field.scoreMap) {
      if (Array.isArray(raw)) pts = raw.reduce((s, v) => s + (field.scoreMap![String(v)] || 0), 0);
      else pts = field.scoreMap[String(raw ?? '')] ?? 0;
    } else if (field.type === 'scale') {
      const n = Number(raw);
      pts = Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
    } else if (field.type === 'multiselect' && field.maxScore) {
      const n = Array.isArray(raw) ? raw.length : 0;
      pts = Math.min(field.maxScore, n);
    } else if (field.type === 'textarea' && field.maxScore) {
      const len = String(raw ?? '').trim().length;
      pts = Math.min(field.maxScore, Math.round((len / 120) * field.maxScore));
    }
    if (field.maxScore) pts = Math.min(field.maxScore, pts);
    if (pts || field.scoreMap || field.maxScore) breakdown[field.id] = pts;
  }
  const score = Math.min(100, Math.round(Object.values(breakdown).reduce((s, n) => s + n, 0)));
  return { score, breakdown };
}
