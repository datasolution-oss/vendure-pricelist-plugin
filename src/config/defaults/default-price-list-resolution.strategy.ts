import { ID } from '@vendure/common/lib/shared-types';
import {
    CacheService,
    Injector,
    Logger,
    RequestContext,
    TransactionalConnection,
    TranslatorService,
} from '@vendure/core';
import { In } from 'typeorm';

import { PRICELIST_PLUGIN_OPTIONS, loggerCtx } from '../../constants';
import { PriceListGroup } from '../../entities/price-list-group.entity';
import { PriceList } from '../../entities/price-list.entity';
import { PluginInitOptions } from '../../types';
import { ResolvedPriceListGroup } from '../../types/resolved-price';
import { PriceListResolutionStrategy } from '../price-list-resolution-strategy';

import { ChannelMatchPredicate } from './channel-match.predicate';
import { DateValidityPredicate } from './date-validity.predicate';
import { EnabledPredicate } from './enabled.predicate';
import { SoftDeletedPredicate } from './soft-deleted.predicate';

const CACHE_NS = 'pricelist:resolution';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h safety cap

interface CachedEntry {
    /** UTC ms — soonest future boundary across candidate lists, or
     *  `now + defaultCacheTtlMs` if no boundary applies. */
    expiresAt: number;
    /** Serialised groups (just enough to rebuild the runtime shape). */
    groups: Array<{
        group: {
            id: ID;
            code: string;
            priority: number;
            name?: string;
        };
        candidateListIds: ID[];
    }>;
}

/**
 * Reads the materialised access fields on `PriceList`
 * (`assignedToEveryone`, `assignedCustomers`,
 * `assignedCustomerGroups`) to build the candidate set. No
 * polymorphic assignment table since Stage 1B batch 2; no
 * group-level access scope per the lead's "groups are global"
 * direction.
 *
 * The SQL is one `QueryBuilder` against `price_list`, joining the
 * channel + group-membership pivots, with an OR predicate
 * covering the three access dimensions. The validity-predicate
 * chain (date, enabled, channel-match, soft-deleted +
 * caller-supplied extensions) runs in-process after the fetch.
 *
 * Cache layer A: keyed on `(channel, customer, groupIds)`. The TTL
 * is the soonest future date boundary among candidates — so a list
 * that becomes valid at T1 invalidates the cache exactly at T1
 * without a polling thread. See PLAN-STAGE-2 §Q4.
 */
export class DefaultPriceListResolutionStrategy
    implements PriceListResolutionStrategy
{
    private connection!: TransactionalConnection;
    private cacheService!: CacheService;
    private translator!: TranslatorService;
    private options!: PluginInitOptions;

    init(injector: Injector): void {
        this.connection = injector.get(TransactionalConnection);
        this.cacheService = injector.get(CacheService);
        this.translator = injector.get(TranslatorService);
        this.options = injector.get<PluginInitOptions>(PRICELIST_PLUGIN_OPTIONS);
    }

    async resolve(
        ctx: RequestContext,
        customerId: ID | undefined,
        customerGroupIds: ID[],
    ): Promise<ResolvedPriceListGroup[]> {
        // Kill switch — short-circuit before any DB round-trip. The map
        // may be keyed by channel id (programmatic config) or by channel
        // code (the `PRICELIST_KILL_CHANNELS` env var, which ops write
        // using codes, not numeric ids). Check both so either form works.
        const killSwitch = this.options.killSwitchPerChannel ?? {};
        if (killSwitch[String(ctx.channelId)] || killSwitch[ctx.channel.code]) {
            return [];
        }

        const nowUtc = new Date();
        const cacheKey = this.buildCacheKey(ctx, customerId, customerGroupIds);

        // Layer A — try cache. Stored value is the lightweight CachedEntry;
        // we re-hydrate full entities from it (group + lists) to honour
        // the strategy contract (`ResolvedPriceListGroup` carries real
        // entity instances downstream consumers can read translations on).
        const cached = await this.cacheService.get<CachedEntry>(cacheKey);
        if (cached && nowUtc.getTime() < cached.expiresAt) {
            return this.hydrateCached(ctx, cached);
        }

        // Fetch — single query with all the joins. We use a QueryBuilder
        // because the access OR-predicate (assignedToEveryone OR direct
        // customer OR group membership) doesn't map cleanly to TypeORM's
        // `where` object syntax.
        const qb = this.connection
            .getRepository(ctx, PriceList)
            .createQueryBuilder('pl')
            .innerJoin('pl.channels', 'plc', 'plc.id = :channelId', {
                channelId: ctx.channelId,
            })
            // Group bindings are per-channel: the membership carries its own
            // channelId (groups are ChannelAware and may be shared), so scope
            // by the membership's channel rather than the group's.
            .innerJoinAndSelect(
                'pl.groupMemberships',
                'plgm',
                'plgm.channelId = :channelId',
                { channelId: ctx.channelId },
            )
            .innerJoinAndSelect('plgm.group', 'g')
            .leftJoinAndSelect('g.translations', 'g_t')
            .leftJoinAndSelect('pl.translations', 'pl_t')
            .leftJoinAndSelect('pl.channels', 'pl_channels')
            .where('pl.deletedAt IS NULL')
            .andWhere('pl.enabled = true');

        // Access is decided per (PriceList, Channel) via PriceListChannelAccess
        // (assignedToEveryone OR direct customer OR customer-group), replacing
        // the old global list-level access fields.
        const accessClauses: string[] = ['a."assignedToEveryone" = true'];
        const accessParams: Record<string, unknown> = {
            channelId: ctx.channelId,
        };
        if (customerId !== undefined && customerId !== null) {
            accessClauses.push(
                'EXISTS (SELECT 1 FROM price_list_channel_access_customer ac ' +
                    'WHERE ac."accessId" = a.id AND ac."customerId" = :cid)',
            );
            accessParams.cid = customerId;
        }
        if (customerGroupIds.length > 0) {
            accessClauses.push(
                'EXISTS (SELECT 1 FROM price_list_channel_access_customer_group acg ' +
                    'WHERE acg."accessId" = a.id AND acg."customerGroupId" IN (:...cgids))',
            );
            accessParams.cgids = customerGroupIds;
        }
        qb.andWhere(
            'EXISTS (SELECT 1 FROM price_list_channel_access a ' +
                'WHERE a."priceListId" = pl.id AND a."channelId" = :channelId ' +
                `AND (${accessClauses.join(' OR ')}))`,
            accessParams,
        );

        const lists = await qb.getMany();

        // Predicate chain: defaults first, then caller-supplied extensions.
        // `channel-match` and `enabled`/`soft-deleted` are belt-and-suspenders
        // (already in the SQL) — kept so a custom resolution strategy that
        // bypasses this SQL still gets the chain applied.
        const predicates = [
            new DateValidityPredicate(),
            new EnabledPredicate(),
            new ChannelMatchPredicate(),
            new SoftDeletedPredicate(),
            ...(this.options.additionalValidityPredicates ?? []),
        ];
        const filtered = lists.filter(l =>
            predicates.every(p => p.test(ctx, l, nowUtc)),
        );

        // Group by groupId. Each list may appear in one group only —
        // membership uniqueness is implicit (one membership row per
        // (priceListId, groupId)). If a list ends up in multiple groups
        // by data anomaly, it will be returned in each.
        const groupMap = new Map<
            string,
            { group: PriceListGroup; candidates: PriceList[] }
        >();
        for (const list of filtered) {
            for (const membership of list.groupMemberships ?? []) {
                const groupId = String(membership.group.id);
                if (!groupMap.has(groupId)) {
                    groupMap.set(groupId, {
                        group: membership.group,
                        candidates: [],
                    });
                }
                groupMap.get(groupId)!.candidates.push(list);
            }
        }

        // Sort candidates within each group (priority DESC, then
        // startDate ASC nulls first, then id ASC for determinism — see
        // PLAN-STAGE-2 §Q7.2 on the deterministic tiebreaker decision).
        for (const entry of groupMap.values()) {
            entry.candidates.sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority;
                const aStart = a.startDate
                    ? new Date(a.startDate).getTime()
                    : Number.NEGATIVE_INFINITY;
                const bStart = b.startDate
                    ? new Date(b.startDate).getTime()
                    : Number.NEGATIVE_INFINITY;
                if (aStart !== bStart) return aStart - bStart;
                return String(a.id).localeCompare(String(b.id));
            });
        }

        // Sort groups by priority ASC (lowest first — base before
        // promo in the cascade).
        const result: ResolvedPriceListGroup[] = Array.from(groupMap.values())
            .map(entry => ({
                group: this.translator.translate(entry.group, ctx),
                candidates: entry.candidates.map(l =>
                    this.translator.translate(l, ctx),
                ),
            }))
            .sort((a, b) => a.group.priority - b.group.priority);

        await this.writeCache(cacheKey, ctx, customerId, result, nowUtc);
        return result;
    }

    private buildCacheKey(
        ctx: RequestContext,
        customerId: ID | undefined,
        customerGroupIds: ID[],
    ): string {
        const sortedGroupIds = [...customerGroupIds]
            .map(g => String(g))
            .sort()
            .join(',');
        return `${CACHE_NS}:${ctx.channelId}:${customerId ?? 'anon'}:${sortedGroupIds || '-'}`;
    }

    private async hydrateCached(
        ctx: RequestContext,
        cached: CachedEntry,
    ): Promise<ResolvedPriceListGroup[]> {
        if (cached.groups.length === 0) return [];

        const allListIds = Array.from(
            new Set(cached.groups.flatMap(g => g.candidateListIds.map(String))),
        );
        const lists = allListIds.length
            ? await this.connection
                  .getRepository(ctx, PriceList)
                  .find({
                      where: { id: In(allListIds) },
                      relations: ['translations'],
                  })
            : [];
        const listById = new Map(lists.map(l => [String(l.id), l] as const));

        const groupIds = cached.groups.map(g => g.group.id);
        const groups = groupIds.length
            ? await this.connection
                  .getRepository(ctx, PriceListGroup)
                  .find({
                      where: { id: In(groupIds) },
                      relations: ['translations'],
                  })
            : [];
        const groupById = new Map(groups.map(g => [String(g.id), g] as const));

        const result: ResolvedPriceListGroup[] = [];
        for (const g of cached.groups) {
            const groupEntity = groupById.get(String(g.group.id));
            if (!groupEntity) {
                // Data drift since cache write — group deleted under
                // our feet. Drop the entry; next non-cache fetch will
                // refresh.
                Logger.warn(
                    `Cached PriceListGroup ${g.group.id} no longer exists; ignoring.`,
                    loggerCtx,
                );
                continue;
            }
            const candidates: PriceList[] = [];
            for (const id of g.candidateListIds) {
                const list = listById.get(String(id));
                if (list) candidates.push(list);
            }
            result.push({
                group: this.translator.translate(groupEntity, ctx),
                candidates: candidates.map(l => this.translator.translate(l, ctx)),
            });
        }
        return result;
    }

    private async writeCache(
        cacheKey: string,
        ctx: RequestContext,
        customerId: ID | undefined,
        result: ResolvedPriceListGroup[],
        nowUtc: Date,
    ): Promise<void> {
        const ttlMs = this.options.defaultCacheTtlMs ?? DEFAULT_TTL_MS;

        // expiresAt = soonest future boundary in any candidate list,
        // floored at `nowUtc + defaultCacheTtlMs`.
        let soonest = nowUtc.getTime() + ttlMs;
        for (const g of result) {
            for (const list of g.candidates) {
                for (const d of [list.startDate, list.endDate]) {
                    if (!d) continue;
                    const t = new Date(d).getTime();
                    if (t > nowUtc.getTime() && t < soonest) {
                        soonest = t;
                    }
                }
            }
        }
        const expiresAt = soonest;

        const payload: CachedEntry = {
            expiresAt,
            groups: result.map(g => ({
                group: {
                    id: g.group.id,
                    code: g.group.code,
                    priority: g.group.priority,
                },
                candidateListIds: g.candidates.map(l => l.id),
            })),
        };

        await this.cacheService.set(cacheKey, payload as any, {
            ttl: expiresAt - nowUtc.getTime(),
            tags: [
                CACHE_NS,
                `pricelist:channel:${ctx.channelId}`,
                `pricelist:customer:${customerId ?? 'anon'}`,
            ],
        });
    }
}
