/* ═══════════════════════════════════════════════════════════
   MobileSourceSheet — R1 FM5: mobile breakpoint source drawer.
   Wraps the 4 source cards inside a shadcn/Sheet bottom drawer
   so they don't get blocked by the sticky ResultActionCard.
   ═══════════════════════════════════════════════════════════ */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';

export interface MobileSourceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function MobileSourceSheet({
  open,
  onOpenChange,
  children,
}: MobileSourceSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="mobile-source-sheet"
        side="bottom"
        data-testid="mobile-source-sheet"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl"
      >
        <SheetHeader>
          <SheetTitle>
            {t('source.mobile_sheet.title', { defaultValue: 'Live sources' })}
          </SheetTitle>
          <SheetDescription>
            {t('source.mobile_sheet.subtitle', {
              defaultValue: 'External data providers snapshot.',
            })}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export default MobileSourceSheet;
