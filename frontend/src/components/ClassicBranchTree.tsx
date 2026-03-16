import { ReactFlowProvider } from '@xyflow/react';

import { BranchTree } from './BranchTree';

interface ClassicBranchTreeProps {
  onIntervene: (branchId: string, branchTitle: string) => void;
  onDetail: (branchId: string) => void;
}

export function ClassicBranchTree({ onIntervene, onDetail }: ClassicBranchTreeProps) {
  return (
    <ReactFlowProvider>
      <BranchTree onIntervene={onIntervene} onDetail={onDetail} />
    </ReactFlowProvider>
  );
}
