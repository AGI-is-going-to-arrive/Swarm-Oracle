export const SCENARIO_QUESTION_MAX_LENGTH = 2000;

export function clampScenarioQuestion(value: string): string {
  return value.slice(0, SCENARIO_QUESTION_MAX_LENGTH);
}

export function normalizeScenarioQuestionForLaunch(value: string): string {
  return clampScenarioQuestion(value.trim());
}
