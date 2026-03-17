import type { GameplayProfileId } from '../components/gameplayCards';
import type { CampaignDailyChallengeStatus } from '../types';

const CHALLENGE_STORAGE_KEY = 'swarmoracle:daily-challenge:v1';

export interface DailyChallenge {
  id: string;
  question: string;
  questionEn?: string;
  subtitleZh: string;
  subtitleEn: string;
  profileId: GameplayProfileId;
  rounds: number;
  numAgents: number;
  mode: 'blackboard' | 'raw';
  visualizationEnabled: boolean;
}

export interface ChallengeProgressEntry {
  challengeId?: string;
  scenarioId?: string;
  startedAt: string;
  completed: boolean;
  resultBranchId?: string;
  usedCards: string[];
  betPlaced: boolean;
  bettingHit?: boolean | null;
  profileResonance?: 'signature' | 'aligned' | 'offbeat' | null;
}

export interface ResolvedChallengeProgress extends ChallengeProgressEntry {
  source: 'local' | 'campaign' | 'merged';
  usedCardsKnown: boolean;
  betPlacedKnown: boolean;
}

const DAILY_CHALLENGES: DailyChallenge[] = [
  {
    id: 'daily-ai-governance',
    question: '如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？',
    questionEn: 'What if artificial intelligence ruled the world and every nation were governed directly by algorithms?',
    subtitleZh: '治理博弈 · 中央算法与地方民意',
    subtitleEn: 'Governance Conflict · Algorithmic Rule vs Local Voice',
    profileId: 'governance',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-roman-empire',
    question: '如果罗马帝国从未衰落？',
    questionEn: 'What if the Roman Empire never fell?',
    subtitleZh: '帝国统合 · 中央铁军与地方自治',
    subtitleEn: 'Imperial Balance · Central Order vs Provincial Autonomy',
    profileId: 'empire',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-war-front',
    question: '如果世界大战在高度自动化军备时代再次爆发？',
    questionEn: 'What if a world war erupted again in an age of highly automated arsenals?',
    subtitleZh: '战争抉择 · 补给线与停火窗口',
    subtitleEn: 'War Doctrine · Supply Lines and Ceasefire Windows',
    profileId: 'war',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-industry',
    question: '如果工业革命提前一百年到来？',
    questionEn: 'What if the Industrial Revolution arrived a hundred years earlier?',
    subtitleZh: '工业与资源 · 产能扩张与社会缓冲',
    subtitleEn: 'Industry and Resources · Throughput vs Social Buffering',
    profileId: 'industry',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-frontier',
    question: '如果人类在 2000 年就建立了火星殖民地？',
    questionEn: 'What if humanity had established a colony on Mars by the year 2000?',
    subtitleZh: '边疆探索 · 远征速度与生存规则',
    subtitleEn: 'Frontier Expansion · Expedition Pace vs Survival Rules',
    profileId: 'frontier',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-trade-chokepoint',
    question: '如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？',
    questionEn: 'What if the world’s most critical strait were permanently monopolized by a maritime trade consortium?',
    subtitleZh: '贸易绞盘 · 关税杠杆与港口封锁',
    subtitleEn: 'Trade Leverage · Tariff Pressure and Port Choke Points',
    profileId: 'trade',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-legal-veto',
    question: '如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？',
    questionEn: 'What if the supreme court held an emergency veto that could pause every algorithmic policy?',
    subtitleZh: '法律红线 · 紧急否决与程序补丁',
    subtitleEn: 'Legal Red Lines · Emergency Vetoes and Procedural Patches',
    profileId: 'law',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-faith-order',
    question: '如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？',
    questionEn: 'What if a single prophecy became the only legitimate basis for ruling an entire kingdom?',
    subtitleZh: '神权号角 · 圣谕改写与异端审判',
    subtitleEn: 'Sacred Order · Rewritten Prophecy and Heresy Trials',
    profileId: 'faith',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-ecology-threshold',
    question: '如果跨大陆淡水供应在十年内枯竭，会发生什么？',
    questionEn: 'What if the cross-continental freshwater supply ran dry within a decade?',
    subtitleZh: '生态阈值 · 迁徙窗口与系统韧性',
    subtitleEn: 'Ecology Thresholds · Migration Windows and System Resilience',
    profileId: 'ecology',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-mythic-pact',
    question: '如果王国与巨龙订立的守护契约在一夜之间失效，会发生什么？',
    questionEn: 'What if the kingdom’s protective pact with its dragons failed overnight?',
    subtitleZh: '神话秩序 · 龙契约与禁术代价',
    subtitleEn: 'Mythic Order · Dragon Pacts and Forbidden Costs',
    profileId: 'mythic',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-survival-grid',
    question: '如果最后一座避难城只能再维持三十天供电，会发生什么？',
    questionEn: 'What if the last refuge city had only thirty days of power left?',
    subtitleZh: '生存极限 · 最后冗余与撤退路线',
    subtitleEn: 'Survival Pressure · Last Reserves and Retreat Routes',
    profileId: 'survival',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    id: 'daily-generic-shuffle',
    question: '如果所有大型组织都必须每周随机交换一次负责人，会发生什么？',
    questionEn: 'What if every major organization had to randomly swap its leader once a week?',
    subtitleZh: '通用博弈 · 关键分歧与隐藏议程',
    subtitleEn: 'General Tension · Core Frictions and Hidden Agendas',
    profileId: 'generic',
    rounds: 3,
    numAgents: 3,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
];

export function challengeDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const getChallengeDayKey = challengeDateKey;

function loadProgressStore(): Record<string, Record<string, ChallengeProgressEntry>> {
  try {
    return JSON.parse(window.localStorage.getItem(CHALLENGE_STORAGE_KEY) || '{}') as Record<string, Record<string, ChallengeProgressEntry>>;
  } catch {
    return {};
  }
}

function saveProgressStore(store: Record<string, Record<string, ChallengeProgressEntry>>) {
  window.localStorage.setItem(CHALLENGE_STORAGE_KEY, JSON.stringify(store));
}

export function getTodayChallenge(date = new Date()): DailyChallenge {
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayIndex = Math.floor(localMidnight.getTime() / 86400000);
  return DAILY_CHALLENGES[dayIndex % DAILY_CHALLENGES.length];
}

export function getChallengeQuestion(challenge: DailyChallenge, isZh: boolean) {
  return isZh ? challenge.question : (challenge.questionEn ?? challenge.question);
}

export function getChallengeProgress(challengeId: string, date = new Date()) {
  const store = loadProgressStore();
  const dayStore = store[challengeDateKey(date)] ?? {};
  return (
    dayStore[challengeId]
    ?? Object.values(dayStore).find((entry) => entry.challengeId === challengeId)
    ?? null
  );
}

export function isChallengeScenario(
  challengeId: string,
  scenarioId: string,
  date = new Date(),
) {
  return getChallengeProgress(challengeId, date)?.scenarioId === scenarioId;
}

export function markChallengeStarted(challengeId: string, scenarioId: string, date = new Date()) {
  const key = challengeDateKey(date);
  const store = loadProgressStore();
  store[key] ??= {};
  store[key][challengeId] = {
    challengeId,
    scenarioId,
    startedAt: new Date().toISOString(),
    completed: false,
    usedCards: [],
    betPlaced: false,
  };
  saveProgressStore(store);
}

export function markChallengeCompleted(
  challengeId: string,
  scenarioId: string,
  result: Partial<ChallengeProgressEntry>,
  date = new Date(),
) {
  const key = challengeDateKey(date);
  const store = loadProgressStore();
  store[key] ??= {};
  store[key][challengeId] = {
    challengeId,
    scenarioId,
    startedAt: store[key][challengeId]?.startedAt ?? new Date().toISOString(),
    completed: true,
    usedCards: result.usedCards ?? store[key][challengeId]?.usedCards ?? [],
    betPlaced: result.betPlaced ?? store[key][challengeId]?.betPlaced ?? false,
    bettingHit: result.bettingHit ?? store[key][challengeId]?.bettingHit ?? null,
    profileResonance: result.profileResonance ?? store[key][challengeId]?.profileResonance ?? null,
    resultBranchId: result.resultBranchId,
  };
  saveProgressStore(store);
}

export function resolveChallengeProgress(
  localProgress: ChallengeProgressEntry | null,
  campaignProgress: CampaignDailyChallengeStatus | null,
): ResolvedChallengeProgress | null {
  if (!campaignProgress?.completed) {
    if (!localProgress) return null;
    return {
      ...localProgress,
      source: 'local',
      usedCardsKnown: true,
      betPlacedKnown: true,
    };
  }

  const sameScenario = Boolean(
    localProgress?.scenarioId
    && campaignProgress.scenario_id
    && localProgress.scenarioId === campaignProgress.scenario_id,
  );

  return {
    challengeId: localProgress?.challengeId,
    scenarioId: campaignProgress.scenario_id ?? localProgress?.scenarioId,
    startedAt: localProgress?.startedAt ?? campaignProgress.completed_at ?? new Date().toISOString(),
    completed: true,
    resultBranchId: localProgress?.resultBranchId,
    usedCards: sameScenario ? localProgress?.usedCards ?? [] : [],
    betPlaced: sameScenario ? (localProgress?.betPlaced ?? false) : campaignProgress.betting_hit != null,
    bettingHit: campaignProgress.betting_hit ?? localProgress?.bettingHit ?? null,
    profileResonance: campaignProgress.profile_resonance ?? localProgress?.profileResonance ?? null,
    source: localProgress ? 'merged' : 'campaign',
    usedCardsKnown: sameScenario,
    betPlacedKnown: sameScenario || campaignProgress.betting_hit != null,
  };
}

export function findChallengeProgressByScenarioId(scenarioId: string) {
  const store = loadProgressStore();
  const days = Object.keys(store).sort().reverse();

  for (const challengeDay of days) {
    const dayStore = store[challengeDay] ?? {};
    for (const entry of Object.values(dayStore)) {
      if (entry.scenarioId === scenarioId) {
        return {
          challengeDay,
          challengeId: entry.challengeId ?? null,
          progress: entry,
        };
      }
    }
  }

  return null;
}
