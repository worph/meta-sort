/**
 * `contentKind` → `domain` — the routing table from METADATA_KEYS.md §1.
 *
 * `domain` answers "which application is this record destined for?" and is the
 * key every client filters its catalogue on. It is **stored, not derived on
 * read**: that is what lets the `contentKind` vocabulary stay open, because a
 * peer that has never heard of a kind still routes the record correctly
 * without having to interpret the token.
 *
 * ⚠ This binding is **permanent and one-way**. Add kinds freely; never re-map
 * an existing kind to a different domain. Because the value is stored, two
 * peers on different versions that disagree about where a kind belongs produce
 * a split-brain that redeploying cannot heal — the wrong domain is already
 * written into records across the mesh. If a kind has to move, mint a new kind.
 */
export type Domain =
    'film'
    | 'tv'
    | 'music'
    | 'spoken'
    | 'literature'
    | 'science';

/**
 * The one-way binding. A kind that is absent here has no domain, which means
 * the record is **not independently routable** — correct for sidecars
 * (subtitles, artwork) and for un-anchored hits, a producer bug for anything
 * else.
 *
 * ⚠ `pack` is deliberately absent: a season pack and an album release are the
 * same structural thing, so the kind alone cannot tell `tv` from `music`. The
 * writer stamps `pack`'s domain from its own context — see
 * {@link domainForContentKind}'s contract.
 */
export const domainByContentKind: { [contentKind: string]: Domain } = {
    // film / tv
    movie: 'film',
    series: 'tv',
    episode: 'tv',
    // music
    track: 'music',
    album: 'music',
    artist: 'music',
    musicVideo: 'music',
    djMix: 'music',
    liveSet: 'music',
    // spoken
    podcast: 'spoken',
    podcastEpisode: 'spoken',
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
