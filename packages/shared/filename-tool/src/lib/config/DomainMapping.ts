/**
 * `contentKind` → `domain` / `workForm` — the routing tables from
 * METADATA_KEYS.md §1.
 *
 * `domain` answers "which application is this record destined for?" and is the
 * key every client filters its catalogue on — **one value per app**, no
 * alternation. `workForm` answers the other question the old `film`/`tv` split
 * was secretly encoding: is this work complete in itself, or one instalment of
 * a run? It is cross-domain, so a comic issue is `serial` in `literature`
 * exactly as an episode is `serial` in `screen`.
 *
 * Both are **stored, not derived on read**: that is what lets the `contentKind`
 * vocabulary stay open, because a peer that has never heard of a kind still
 * routes the record correctly without having to interpret the token.
 *
 * ⚠ This binding is **permanent and one-way**. Add kinds freely; never re-map
 * an existing kind to a different domain. Because the value is stored, two
 * peers on different versions that disagree about where a kind belongs produce
 * a split-brain that redeploying cannot heal — the wrong domain is already
 * written into records across the mesh. If a kind has to move, mint a new kind.
 * The `film`+`tv` → `screen` merge (METADATA_KEYS.md §14.17) is the one
 * deliberate exception, taken once and paid for with a corpus sweep.
 *
 * ⚠ Mirror of the Rust table in `meta-feeder-sdk::domain`. Edit both together.
 */
export type Domain =
    'screen'
    | 'music'
    | 'literature'
    | 'science';

/** Is the work complete in itself, or one instalment of a run? */
export type WorkForm = 'standalone' | 'serial';

/**
 * The one-way binding. A kind that is absent here has no domain, which means
 * the record is **not independently routable** — correct for sidecars
 * (subtitles, artwork) and for un-anchored hits, a producer bug for anything
 * else.
 *
 * ⚠ `pack` is deliberately absent: a season pack and an album release are the
 * same structural thing, so the kind alone cannot tell `screen` from `music`.
 * The writer stamps `pack`'s domain from its own context — see
 * {@link domainForContentKind}'s contract.
 *
 * ⚠ `podcast` / `podcastEpisode` are absent too: the `spoken` domain was
 * retired unused, and the change that first *writes* those kinds picks their
 * domain.
 */
export const domainByContentKind: { [contentKind: string]: Domain } = {
    // screen — films and serials alike; the split lives in workFormByContentKind
    movie: 'screen',
    series: 'screen',
    episode: 'screen',
    // music
    track: 'music',
    album: 'music',
    artist: 'music',
    musicVideo: 'music',
    djMix: 'music',
    liveSet: 'music',
    // literature
    book: 'literature',
    // An audiobook's identity is the book — same author, same ISBN family,
    // same series as the ebook — so meta-read can group the two editions on
    // one page. The player does not decide the domain.
    audiobook: 'literature',
    comic: 'literature',
    manga: 'literature',
    magazine: 'literature',
    // science
    paper: 'science',
};

/**
 * The `workForm` twin of {@link domainByContentKind}.
 *
 * ⚠ `pack` is absent for the same reason: a season pack is `serial`, an album
 * release is `standalone`, and only the writer knows which.
 */
export const workFormByContentKind: { [contentKind: string]: WorkForm } = {
    // screen
    movie: 'standalone',
    series: 'serial',
    episode: 'serial',
    // music — an album is a closed work, not an ongoing run, so every rung of
    // the music ladder is standalone.
    track: 'standalone',
    album: 'standalone',
    artist: 'standalone',
    musicVideo: 'standalone',
    djMix: 'standalone',
    liveSet: 'standalone',
    // literature — the split that proves workForm is not a screen-only axis.
    book: 'standalone',
    audiobook: 'standalone',
    comic: 'serial',
    manga: 'serial',
    magazine: 'serial',
    // science
    paper: 'standalone',
};

/**
 * Resolve the domain a `contentKind` belongs to.
 *
 * Returns `undefined` for `pack` (not derivable from the kind — the writer
 * supplies it), for sidecar/format kinds that route nowhere, and for any kind
 * this build has never heard of. A caller that already knows the domain from
 * its own context must prefer that over this table.
 */
export function domainForContentKind(contentKind: string | undefined | null): Domain | undefined {
    if (!contentKind) return undefined;
    return domainByContentKind[contentKind.trim()];
}

/**
 * Resolve the work form a `contentKind` sits on. Same contract as
 * {@link domainForContentKind}: `undefined` means "not derivable", never a
 * guess. Whoever writes `contentKind` writes both of these in the same breath.
 */
export function workFormForContentKind(contentKind: string | undefined | null): WorkForm | undefined {
    if (!contentKind) return undefined;
    return workFormByContentKind[contentKind.trim()];
}
