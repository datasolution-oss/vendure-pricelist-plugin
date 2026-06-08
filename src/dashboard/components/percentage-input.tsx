import { Input } from '@/vdb/components/ui/input.js';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/vdb/components/ui/tooltip.js';
import { useLingui } from '@lingui/react/macro';
import { HelpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

interface PercentageInputProps {
    /** Basis-point integer (1000 = 10%). */
    value: number;
    /** Receives the basis-point integer back. */
    onChange: (value: number) => void;
    onBlur?: () => void;
    disabled?: boolean;
    name?: string;
}

/**
 * Renders a "10.00 %" input that persists basis-point integers
 * (1000 = 10%). The bp convention is plugin-specific (Sylius/Magento
 * use float; we chose bp for FP-free arithmetic) — the tooltip
 * documents this for merchandisers in the form.
 *
 * Conversion is `bp = round(displayed × 100)`. Validation clamps to
 * [0, 10000].
 */
export function PercentageInput({
    value,
    onChange,
    onBlur,
    disabled,
    name,
}: Readonly<PercentageInputProps>) {
    const { t } = useLingui();
    const [display, setDisplay] = useState<string>(formatBp(value));

    // Keep local display in sync if the parent updates the value.
    useEffect(() => {
        setDisplay(formatBp(value));
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDisplay(e.target.value);
    };

    const handleBlur = () => {
        const parsed = parseFloat(display);
        const bp = Number.isFinite(parsed)
            ? Math.max(0, Math.min(10000, Math.round(parsed * 100)))
            : 0;
        onChange(bp);
        setDisplay(formatBp(bp));
        onBlur?.();
    };

    return (
        <div className="flex items-center gap-2">
            <div className="relative flex-1">
                <Input
                    type="number"
                    name={name}
                    value={display}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    disabled={disabled}
                    min={0}
                    max={100}
                    step={0.01}
                    className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    %
                </span>
            </div>
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger>
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                        <div className="space-y-1 text-xs">
                            <div>
                                {t`Discount in basis points. Stored as an integer (e.g. 1000 = 10%) to avoid float drift.`}
                            </div>
                            <div>
                                {t`Applied as running × (1 − value / 10000).`}
                            </div>
                            <div>
                                {t`Two stacked −10% lines compound to −19%, not −20%.`}
                            </div>
                        </div>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>
    );
}

function formatBp(bp: number): string {
    if (!Number.isFinite(bp)) return '0.00';
    return (bp / 100).toFixed(2);
}
