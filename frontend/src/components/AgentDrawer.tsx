import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from './ui/sheet';
import { AgentAttachPanel } from './AgentAttachPanel';
import './AgentDrawer.css';

interface AgentDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  maxSelected: number;
}

export function AgentDrawer({
  open,
  onOpenChange,
  userId,
  maxSelected,
}: AgentDrawerProps) {
  const { t } = useTranslation();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="agent-drawer"
        hideCloseButton
        data-testid="agent-drawer"
      >
        <SheetHeader className="agent-drawer__header">
          <SheetTitle className="agent-drawer__title">
            {t('agents.drawer_title')}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t('agents.drawer_title')}
          </SheetDescription>
          <SheetClose asChild>
            <button
              type="button"
              className="agent-drawer__close-btn"
              aria-label={t('agents.drawer_close')}
            >
              {t('agents.drawer_close')}
            </button>
          </SheetClose>
        </SheetHeader>
        <div className="agent-drawer__content">
          <AgentAttachPanel
            userId={userId}
            visible={open}
            maxSelected={maxSelected}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
