export type AgentPaletteToken = {
  accent: string;
  surface: string;
};

const AGENT_PALETTE: AgentPaletteToken[] = [
  { accent: '#004e89', surface: '#edf5fb' },
  { accent: '#1a936f', surface: '#edf8f4' },
  { accent: '#7b2d8e', surface: '#f6eff8' },
  { accent: '#a04a00', surface: '#fff4e8' },
  { accent: '#2f5ea8', surface: '#eef3fb' },
  { accent: '#6d5a00', surface: '#fff9dc' },
  { accent: '#116a7a', surface: '#edf8fa' },
  { accent: '#8a2d44', surface: '#fff0f4' },
];

function hashAgentId(agentId: string): number {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getAgentPaletteToken(agentId: string): AgentPaletteToken {
  return AGENT_PALETTE[hashAgentId(agentId) % AGENT_PALETTE.length] ?? AGENT_PALETTE[0];
}
