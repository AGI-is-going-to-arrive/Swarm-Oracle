import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentPanel } from './AgentPanel';
import type { AgentInfo, AgentMessage, BranchInfo } from '../types';

const makeBranch = (id: string, title: string, forkRound: number): BranchInfo => ({
  id,
  parent_branch_id: forkRound > 0 ? 'root' : null,
  fork_round: forkRound,
  fork_reason: '',
  title,
  description: title,
  summary: '',
  story: '',
  insight: '',
  key_moments: [],
  probability: 0.5,
  status: 'ACTIVE',
});

const zhou: AgentInfo = {
  id: 'zhou',
  name: '周鸿祎',
  role: '互联网企业家与安全领域意见领袖',
  tier: 'IMPORTANT',
  stance: '支持',
  emotion: 'neutral',
};

const sam: AgentInfo = {
  id: 'sam',
  name: 'Sam Altman',
  role: 'OpenAI CEO',
  tier: 'CORE',
  stance: '反对',
  emotion: 'neutral',
};

let mockState: {
  agents: AgentInfo[];
  branches: BranchInfo[];
  messages: AgentMessage[];
};

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        'sim.panel.agent_list': 'Agent 列表',
        'sim.panel.live_messages': '实时发言',
        'sim.panel.saved_messages': '已保存的发言',
        'sim.panel.saved_empty': '这份记录尚无已保存的发言。',
        'sim.panel.waiting': '等待发言...',
        'sim.panel.round': 'R',
        'sim.panel.tier_core': '核心',
        'sim.panel.tier_important': '重要',
        'sim.panel.tier_crowd': '群众',
        'sim.panel.show_all': '显示全部',
        'sim.panel.filter_agent': `筛选 ${vars?.name ?? ''} 的消息`,
        'sim.panel.no_agent_messages': '该 Agent 暂无发言',
        'sim.panel.worldline_group': `世界线：${vars?.title ?? ''}`,
        'sim.panel.worldline_round_range': `R${vars?.start ?? ''}-R${vars?.end ?? ''}`,
        'sim.panel.view_agent_profile': `查看 ${vars?.name ?? ''} 的档案`,
        'sim.panel.emotion_metadata_unavailable': '情绪元数据不可用',
        'sim.panel.new_messages': `${vars?.count ?? 0} 条新消息`,
        'sim.panel.jump_to_latest': '跳至最新消息',
      };
      return labels[key] ?? key;
    },
  }),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mockState = {
    agents: [sam, zhou],
    branches: [
      makeBranch('alpha', '放大生态拿下默认入口', 2),
      makeBranch('beta', '停在声量热度错过窗口', 2),
    ],
    messages: [
      { agent: '周鸿祎', agent_id: 'zhou', branch: 'alpha', round: 5, emotion: 'calm', message: 'alpha r5' },
      { agent: '周鸿祎', agent_id: 'zhou', branch: 'alpha', round: 2, emotion: 'calm', message: 'alpha r2' },
      { agent: '周鸿祎', agent_id: 'zhou', branch: 'beta', round: 5, emotion: 'calm', message: 'beta r5' },
      { agent: 'Sam Altman', agent_id: 'sam', branch: 'alpha', round: 2, emotion: 'calm', message: 'sam r2' },
      { agent: '周鸿祎', agent_id: 'zhou', branch: 'beta', round: 2, emotion: 'calm', message: 'beta r2' },
      { agent: '周鸿祎', agent_id: 'zhou', branch: 'beta', round: 3, emotion: 'calm', message: 'beta r3' },
    ],
  };
});

describe('AgentPanel', () => {
  function scrollFeed(container: HTMLElement, top: number, height = 1000): HTMLDivElement {
    const list = container.querySelector<HTMLDivElement>('.message-list')!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: height },
    });
    list.scrollTop = top;
    fireEvent.scroll(list);
    return list;
  }

  function appendMessage(agentId = 'zhou'): void {
    mockState.messages = [...mockState.messages, {
      agent: agentId === 'zhou' ? '周鸿祎' : 'Sam Altman', agent_id: agentId,
      branch: 'alpha', round: 6, emotion: 'calm', message: `new ${mockState.messages.length}`,
    }];
  }

  it('keeps the reading position and accumulates a jump control for new messages', () => {
    const view = render(<AgentPanel />);
    const list = scrollFeed(view.container, 100);
    appendMessage();
    view.rerender(<AgentPanel />);
    appendMessage();
    view.rerender(<AgentPanel />);

    expect(list.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: '2 条新消息 跳至最新消息' }));
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByText('2 条新消息')).not.toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('follows additions only while near the bottom and resumes after scrolling back', () => {
    const view = render(<AgentPanel />);
    const list = scrollFeed(view.container, 730);
    appendMessage();
    view.rerender(<AgentPanel />);
    expect(list.scrollTop).toBe(1000);
    scrollFeed(view.container, 100);
    appendMessage();
    view.rerender(<AgentPanel />);
    expect(list.scrollTop).toBe(100);
    scrollFeed(view.container, 790);
    expect(screen.queryByText('1 条新消息')).not.toBeInTheDocument();
    appendMessage();
    view.rerender(<AgentPanel />);
    expect(list.scrollTop).toBe(1000);
  });

  it('detects new messages when a capped feed drops its oldest item', () => {
    const view = render(<AgentPanel />);
    const list = scrollFeed(view.container, 100);
    const originalLength = mockState.messages.length;
    appendMessage();
    mockState.messages = mockState.messages.slice(1);
    view.rerender(<AgentPanel />);
    expect(mockState.messages.length).toBe(originalLength);
    expect(list.scrollTop).toBe(100);
    expect(screen.getByText('1 条新消息')).toBeInTheDocument();
  });

  it('labels archived messages honestly and never auto-follows refreshes of saved content', () => {
    const view = render(<AgentPanel live={false} />);
    const list = scrollFeed(view.container, 780);
    expect(screen.getByRole('heading', { name: '已保存的发言' })).toBeInTheDocument();
    appendMessage();
    view.rerender(<AgentPanel live={false} />);
    expect(list.scrollTop).toBe(780);
    expect(screen.queryByText(/条新消息/)).not.toBeInTheDocument();
    fireEvent.click(view.container.querySelector('.bubble-agent')!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });
    expect(view.container.querySelector('.agent-card--highlight')).toBeNull();
  });

  it('does not count messages excluded by the selected agent filter', () => {
    const view = render(<AgentPanel />);
    fireEvent.click(screen.getByTitle('筛选 周鸿祎 的消息'));
    const list = scrollFeed(view.container, 100);
    appendMessage('sam');
    view.rerender(<AgentPanel />);
    expect(list.scrollTop).toBe(100);
    expect(screen.queryByText(/条新消息/)).not.toBeInTheDocument();
    appendMessage();
    view.rerender(<AgentPanel />);
    expect(screen.getByText('1 条新消息')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sim.panel.clear_filter' }));
    expect(screen.queryByText(/条新消息/)).not.toBeInTheDocument();
  });

  it('uses instant card scrolling without highlight animation for reduced motion', () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const view = render(<AgentPanel />);
    fireEvent.click(view.container.querySelector('.bubble-agent')!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' });
    expect(view.container.querySelector('.agent-card--highlight')).toBeNull();
    matchMedia.mockRestore();
  });

  it('labels unavailable message emotion instead of rendering it as neutral', () => {
    mockState.messages = [{
      agent: '周鸿祎',
      agent_id: 'zhou',
      branch: 'alpha',
      round: 6,
      emotion: '',
      emotion_metadata_status: 'unavailable',
      emotion_metadata_failure_code: 'LLM_TIMEOUT',
      message: '真实发言仍然保留。',
    } as AgentMessage];

    render(<AgentPanel />);

    const unavailable = screen.getByText('情绪元数据不可用 (LLM_TIMEOUT)');
    expect(unavailable).toBeInTheDocument();
    expect(unavailable.closest('.bubble-header')?.querySelector('.emotion-dot')).toBeNull();
    expect(screen.getByText('真实发言仍然保留。')).toBeInTheDocument();
  });

  it('does not render malformed or provider error details as a failure code', () => {
    mockState.messages = [{
      agent: '周鸿祎',
      agent_id: 'zhou',
      branch: 'alpha',
      round: 6,
      emotion: '',
      emotion_metadata_status: 'unavailable',
      emotion_metadata_failure_code: '__swarmoracle_metadata_unavailable__:upstream said secret',
      message: '正文不受第二阶段失败影响。',
    } as AgentMessage];

    render(<AgentPanel />);

    expect(screen.getByText('情绪元数据不可用 (LLM_FAILED)')).toBeInTheDocument();
    expect(screen.queryByText(/upstream said secret/i)).not.toBeInTheDocument();
  });

  it('opens an explicit profile action without changing the message filter', async () => {
    const onViewProfile = vi.fn();
    render(<AgentPanel onViewProfile={onViewProfile} />);

    await userEvent.click(screen.getByRole('button', { name: '查看 周鸿祎 的档案' }));

    expect(onViewProfile).toHaveBeenCalledWith('zhou');
    expect(screen.queryByTestId('agent-worldline-group')).not.toBeInTheDocument();
  });

  it('groups selected-agent messages by worldline and sorts rounds inside each worldline', async () => {
    render(<AgentPanel />);

    const filterButton = screen.getByTitle('筛选 周鸿祎 的消息');
    expect(filterButton).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(filterButton);

    expect(filterButton).toHaveAttribute('aria-pressed', 'true');

    const groups = screen.getAllByTestId('agent-worldline-group');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByText('世界线：放大生态拿下默认入口')).toBeInTheDocument();
    expect(within(groups[0]).getByText('R2-R5')).toBeInTheDocument();
    expect(within(groups[1]).getByText('世界线：停在声量热度错过窗口')).toBeInTheDocument();
    expect(within(groups[1]).getByText('R2-R5')).toBeInTheDocument();

    const roundsByGroup = groups.map((group) =>
      Array.from(group.querySelectorAll('.bubble-round')).map((node) => node.textContent),
    );
    expect(roundsByGroup).toEqual([
      ['R2', 'R5'],
      ['R2', 'R3', 'R5'],
    ]);
  });
});
