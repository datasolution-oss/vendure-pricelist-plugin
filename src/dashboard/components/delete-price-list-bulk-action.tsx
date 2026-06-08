import { DataTableBulkActionItem } from '@/vdb/components/data-table/data-table-bulk-action-item.js';
import { BulkActionComponent } from '@/vdb/framework/extension-api/types/data-table.js';
import { api } from '@/vdb/graphql/api.js';
import { usePaginatedList } from '@/vdb/hooks/use-paginated-list.js';
import { useLingui } from '@lingui/react/macro';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
    deletePriceListMutation,
    deletePriceListGroupMutation,
} from '../gql/mutations';

/**
 * Soft-deletes selected pricelists. Our `deletePriceList` mutation is
 * single-id (one row per call), so we fan out N parallel mutations
 * rather than relying on a bulk-id mutation we don't have. For the
 * test data sizes used in v1 this is fine; a true bulk endpoint is a
 * tiny follow-up if/when lists get very large.
 */
export const DeletePriceListBulkAction: BulkActionComponent<any> = ({
    selection,
    table,
}) => {
    const { t } = useLingui();
    const { refetchPaginatedList } = usePaginatedList();

    const runDelete = async () => {
        try {
            const results = await Promise.allSettled(
                selection.map(item =>
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
            confirmationText={t`Are you sure you want to delete ${selection.length} pricelists?`}
            icon={Trash2}
            className="text-destructive"
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
            const results = await Promise.allSettled(
                selection.map(item =>
                    api.mutate(deletePriceListGroupMutation, { id: item.id } as any),
                ),
            );
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            if (succeeded > 0) {
                toast.success(t`Deleted ${succeeded} groups`);
            }
            if (failed > 0) {
                toast.error(
                    t`Failed to delete ${failed} groups (default groups cannot be deleted).`,
                );
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
