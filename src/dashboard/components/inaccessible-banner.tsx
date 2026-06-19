import { Alert, AlertDescription, AlertTitle } from '@/vdb/components/ui/alert.js';
import { useLingui } from '@lingui/react/macro';
import { TriangleAlert } from 'lucide-react';

interface InaccessibleBannerProps {
    /** Pricelist is disabled (global flag) — no customer gets these prices. */
    isDisabled: boolean;
    /**
     * On the active channel: not available to everyone AND no customer / no
     * customer group is assigned — so nobody is in scope on this channel.
     */
    hasNoAudience: boolean;
}

/**
 * Warns that, with the current configuration, this pricelist reaches no
 * customer. Two independent reasons can cause it (disabled, or no audience
 * on the active channel); the banner lists whichever apply so the
 * merchandiser knows what to change. Access is channel-scoped, so the
 * audience reason is evaluated against the active channel only.
 *
 * Render only when `isDisabled || hasNoAudience` (callsite responsibility).
 */
export function InaccessibleBanner({ isDisabled, hasNoAudience }: Readonly<InaccessibleBannerProps>) {
    const { t } = useLingui();
    return (
        <Alert>
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>{t`This pricelist is not reachable by any customer`}</AlertTitle>
            <AlertDescription>
                <ul className="list-disc pl-4">
                    {isDisabled && <li>{t`It is disabled — enable it to make its prices apply.`}</li>}
                    {hasNoAudience && (
                        <li>
                            {t`On the active channel it is not available to everyone, and no customer or customer group is assigned. Add an audience in "Customer access" below or enable "Available to everyone".`}
                        </li>
                    )}
                </ul>
            </AlertDescription>
        </Alert>
    );
}
