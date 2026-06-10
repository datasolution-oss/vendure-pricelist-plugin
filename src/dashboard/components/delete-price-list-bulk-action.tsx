import { DataTableBulkActionItem } from '@/vdb/components/data-table/data-table-bulk-action-item.js';
import { BulkActionComponent } from '@/vdb/framework/extension-api/types/data-table.js';
import { api } from '@/vdb/graphql/api.js';
import { usePaginatedList } from '@/vdb/hooks/use-paginated-list.js';
import { useLingui } from '@lingui/react/macro';
import { RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
    deletePriceListMutation,
    deletePriceListGroupMutation,
    restorePriceListMutation,
} from '../gql/mutations';

/**
 * Soft-deletes selected pricelists. Our `deletePriceList` mutation is
 * single-id (one row per call), so we fan out N parallel mutations
 * rather than relying on a bulk-id mutation we don't have.
 *
 * Because Vendure renders every bulk action inside the per-row
 * actions dropdown too (with `selection: [row]`), this component
 * doubles as the single-row Delete. It hides itself
 * (`return null`) when EVERY selected row is already pending
 * deletion — a soft-deleted list has nothing left to delete; the
 * Restore action takes over for those rows. Deleted rows mixed into
 * a multi-select are filtered out of the actual mutation.
 */
export const DeletePriceListBulkAction: BulkActionComponent<any> = ({
    selection,
    table,
}) => {
    const { t } = useLingui();
    const { refetchPaginatedList } = usePaginatedList();

    const deletable = selection.filter((item: any) => !item.deletedAt);
    if (deletable.length === 0) {
        return null;
    }

    const runDelete = async () => {
        try {
            const results = await Promise.allSettled(
                deletable.map(item =>
                    api.mutate(deletePriceListMutation, { id: item.id } as any),
                ),
            );
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            if (succeeded > 0) {
                toast.success(t`Deleted ${succeeded} pricelists`);
            }
            if (failed > 0) {
                toast.error(t`Failed to delete ${failed} pricelists`);
            }
            refetchPaginatedList();
            table.resetRowSelection();
        } catch (err) {
            console.error('[pricelist] bulk delete failed:', err);
            toast.error(t`Bulk delete failed`);
        }
    };

    return (
        <DataTableBulkActionItem
            requiresPermission={['DeletePriceList']}
            onClick={runDelete}
            label={t`Delete`}
            confirmationText={t`Are you sure you want to delete ${deletable.length} pricelists?`}
            icon={Trash2}
            className="text-destructive"
        />
    );
};

/**
 * Restores selected pricelists that are pending deletion (clears
 * `deletedAt`). Mirror of the Delete action: hides itself when no
 * selected row is pending deletion, so an active row's dropdown only
 * shows Delete and a pending row's dropdown only shows Restore.
 */
export const RestorePriceListBulkAction: BulkActionComponent<any> = ({
    selection,
    table,
}) => {
    const { t } = useLingui();
    const { refetchPaginatedList } = usePaginatedList();

    const restorable = selection.filter((item: any) => !!item.deletedAt);
    if (restorable.length === 0) {
        return null;
    }

    const runRestore = async () => {
        try {
            const results = await Promise.allSettled(
                restorable.map(item =>
                    api.mutate(restorePriceListMutation, { id: item.id } as any),
                ),
            );
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            if (succeeded > 0) {
                toast.success(t`Restored ${succeeded} pricelists`);
            }
            if (failed > 0) {
                toast.error(t`Failed to restore ${failed} pricelists`);
            }
            refetchPaginatedList();
            table.resetRowSelection();
        } catch (err) {
            console.error('[pricelist] bulk restore failed:', err);
            toast.error(t`Bulk restore failed`);
        }
    };

    return (
        <DataTableBulkActionItem
            requiresPermission={['UpdatePriceList']}
            onClick={runRestore}
            label={t`Restore`}
            confirmationText={t`Restore ${restorable.length} pricelists?`}
            icon={RotateCcw}
        />
    );
};

export const DeletePriceListGroupBulkAction: BulkActionComponent<any> = ({
    selection,
    table,
}) => {
    const { t } = useLingui();
    const { refetchPaginatedList } = usePaginatedList();

    const runDelete = async () => {
        try {
            // The default group is protected (server throws
            // PRICELIST_GROUP_DEFAULT_NOT_DELETABLE). Filter it out
            // client-side so we never even attempt it — the result
            // counts stay honest and the user gets a clear message
            // instead of a generic "failed to delete" for a row they
            // could never remove. Server guard remains the backstop.
            const deletable = selection.filter((item: any) => !item.isDefault);
            const skipped = selection.length - deletable.length;

            if (deletable.length === 0) {
                toast.info(t`The default group cannot be deleted.`);
                table.resetRowSelection();
                return;
            }

            const results = await Promise.allSettled(
                deletable.map(item =>
                    api.mutate(deletePriceListGroupMutation, { id: item.id } as any),
                ),
            );
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            if (succeeded > 0) {
                toast.success(t`Deleted ${succeeded} groups`);
            }
            if (failed > 0) {
                toast.error(t`Failed to delete ${failed} groups`);
            }
            if (skipped > 0) {
                toast.info(t`Skipped the default group (cannot be deleted).`);
            }
            refetchPaginatedList();
            table.resetRowSelection();
        } catch (err) {
            console.error('[pricelist] bulk delete groups failed:', err);
            toast.error(t`Bulk delete failed`);
        }
    };

    return (
        <DataTableBulkActionItem
            requiresPermission={['DeletePriceListGroup']}
            onClick={runDelete}
            label={t`Delete`}
            confirmationText={t`Are you sure you want to delete ${selection.length} groups? Default groups will be skipped.`}
            icon={Trash2}
            className="text-destructive"
        />
    );
};
