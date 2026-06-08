import { useChannel } from '@/vdb/hooks/use-channel.js';

/**
 * Whether the active dashboard channel is allowed to edit the
 * PriceList that owns the given `originChannelId`.
 *
 * Mirrors the service-layer guard `ERR_PRICELIST_READONLY_NON_ORIGIN_CHANNEL`
 * introduced in Stage 1B: a pricelist is editable only from the channel
 * that created it. Shared (non-origin) channels see the list as
 * read-only — the dashboard uses this hook to disable Save / Delete /
 * Add-item affordances and to mount `<ReadOnlyBanner/>` instead of
 * letting the merchandiser hit a server-side IllegalOperationError.
 *
 * Returns `false` until both inputs are available, so callers that
 * destructure during initial render get a safe default that disables
 * write buttons rather than briefly flashing them as editable.
 *
 * Plugin-specific: Vendure core has no equivalent because the
 * "origin-only edit" rule isn't part of the standard ChannelAware
 * model. Standard ChannelAware entities (Product, Promotion) are
 * editable from every channel they're assigned to.
 */
export function useIsEditable(originChannelId?: string | null): boolean {
    const { activeChannel } = useChannel();
    if (!originChannelId || !activeChannel) {
        return false;
    }
    return String(activeChannel.id) === String(originChannelId);
}
