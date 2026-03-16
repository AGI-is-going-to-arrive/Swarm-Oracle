const THEATER_THEME_LABELS: Record<string, { zh: string; en: string }> = {
  medieval_village: { zh: '中世纪村庄', en: 'Medieval Village' },
  ancient_empire: { zh: '古代帝国', en: 'Ancient Empire' },
  industrial_city: { zh: '工业都市', en: 'Industrial City' },
  modern_city: { zh: '现代都市', en: 'Modern City' },
  surveillance_megacity: { zh: '监控巨城', en: 'Surveillance Megacity' },
  civic_chamber: { zh: '公民议会', en: 'Civic Chamber' },
  law_court: { zh: '宪政法庭', en: 'Constitutional Court' },
  imperial_forum: { zh: '帝国元老院', en: 'Imperial Forum' },
  dynastic_palace: { zh: '王朝宫廷', en: 'Dynastic Palace' },
  scifi_base: { zh: '科幻基地', en: 'Sci-Fi Base' },
  power_grid_nexus: { zh: '电网中枢', en: 'Power Grid Nexus' },
  factory_foundry: { zh: '熔炉工场', en: 'Factory Foundry' },
  frontier_colony: { zh: '边疆殖民地', en: 'Frontier Colony' },
  post_apocalypse: { zh: '末日废土', en: 'Post-Apocalypse' },
  fantasy_kingdom: { zh: '奇幻王国', en: 'Fantasy Kingdom' },
  arcane_sanctum: { zh: '秘法圣所', en: 'Arcane Sanctum' },
  faith_temple: { zh: '圣谕神殿', en: 'Sacred Temple' },
  refuge_compound: { zh: '避难营地', en: 'Refuge Compound' },
  war_command: { zh: '战争指挥室', en: 'War Command' },
  logistics_hub: { zh: '后勤枢纽', en: 'Logistics Hub' },
  war_battlefield: { zh: '战争前线', en: 'War Battlefield' },
  space_station: { zh: '空间站', en: 'Space Station' },
  underwater_kingdom: { zh: '海底王国', en: 'Underwater Kingdom' },
  desert_outpost: { zh: '沙漠前哨', en: 'Desert Outpost' },
  trade_harbor: { zh: '贸易海港', en: 'Trade Harbor' },
  ecology_wasteland: { zh: '生态阈值区', en: 'Ecology Threshold Zone' },
};

export function getTheaterThemeLabel(theme: string | null | undefined, isZh: boolean): string | null {
  if (!theme) return null;
  const match = THEATER_THEME_LABELS[theme];
  if (match) return isZh ? match.zh : match.en;
  return theme.replace(/_/g, ' ');
}
