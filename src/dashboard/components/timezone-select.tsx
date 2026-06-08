import { Input } from '@/vdb/components/ui/input.js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/vdb/components/ui/select.js';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

/**
 * IANA timezone picker.
 *
 * Prefers `Intl.supportedValuesOf('timeZone')` (Node 18+ / modern browsers),
 * which exposes the full zoneinfo set as a deduped, normalised list. Falls
 * back to a small hand-picked allow-list when the runtime doesn't expose
 * that API — every entry in the fallback is one we'd realistically want a
 * merchandiser to select. Both paths produce raw IANA names (e.g.
 * `Europe/Paris`) — those are what `PriceList.timezone` stores, and what
 * Stage-2 will pass to `Intl.DateTimeFormat` / `toZonedTime` at lookup.
 *
 * The widget degrades gracefully to a free-text `<Input>` when the list is
 * unavailable, so the field is never blocked.
 */
export interface TimezoneSelectProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

export function TimezoneSelect({
    id,
    value,
    onChange,
    disabled,
}: Readonly<TimezoneSelectProps>) {
    const { t } = useLingui();

    const zones = useMemo<string[]>(() => {
        const intlAny = Intl as unknown as {
            supportedValuesOf?: (key: 'timeZone') => string[];
        };
        if (typeof intlAny.supportedValuesOf === 'function') {
            try {
                return intlAny.supportedValuesOf('timeZone');
            } catch {
                // fall through to manual list
            }
        }
        return [
            'UTC',
            'Europe/Paris',
            'Europe/London',
            'Europe/Berlin',
            'Europe/Madrid',
            'America/New_York',
            'America/Chicago',
            'America/Los_Angeles',
            'America/Sao_Paulo',
            'Asia/Tokyo',
            'Asia/Shanghai',
            'Asia/Singapore',
            'Asia/Dubai',
            'Australia/Sydney',
        ];
    }, []);

    if (zones.length === 0) {
        return (
            <Input
                id={id}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={t`e.g. Europe/Paris`}
                disabled={disabled}
            />
        );
    }

    const known = zones.includes(value);

    return (
        <Select
            value={known ? value : ''}
            onValueChange={(v: string | null) => v && onChange(v)}
            disabled={disabled}
        >
            <SelectTrigger id={id}>
                <SelectValue placeholder={known ? undefined : value || t`Select…`} />
            </SelectTrigger>
            <SelectContent>
                {zones.map(z => (
                    <SelectItem key={z} value={z}>
                        {z}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
