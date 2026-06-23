import { ReactFlowProvider } from '@xyflow/react';

import { BranchTree } from './BranchTree';

interface ClassicBranchTreeProps {
  onIntervene: (branchId: string, branchTitle: string) => void;
  onDetail: (branchId: string) => void;
  canIntervene?: boolean;
}

export function ClassicBranchTree({ onIntervene, onDetail, canIntervene }: ClassicBranchTreeProps) {
  return (
    <ReactFlowProvider>
      <BranchTree onIntervene={onIntervene} onDetail={onDetail} canIntervene={canIntervene} />
    </ReactFlowProvider>
  );
}
