import { Alert, AlertDescription, AlertTitle } from '@/vdb/components/ui/alert.js';
import { useLingui } from '@lingui/react/macro';
import { Lock } from 'lucide-react';

interface ReadOnlyBannerProps {
    originChannelCode: string;
}

/**
 * Surfaces the "edits only allowed from origin channel" service-layer
 * guard at the top of the detail page. Displayed only when the active
 * channel differs from the pricelist's origin (callsite responsibility
 * — pair with `useIsEditable`).
 */
export function ReadOnlyBanner({ originChannelCode }: Readonly<ReadOnlyBannerProps>) {
    const { t } = useLingui();
    return (
        <Alert>
            <Lock className="h-4 w-4" />
            <AlertTitle>{t`Read-only view`}</AlertTitle>
            <AlertDescription>
                {t`This pricelist was created on channel ${originChannelCode}. Edits are only allowed from its origin channel.`}
            </AlertDescription>
        </Alert>
    );
}
