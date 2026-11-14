export type AppType = unknown;

export interface Skill {
  slug: string;
  name: string;
  description: string;
  license?: string;
}

export interface SkillDetail extends Skill {
  content: string;
}
