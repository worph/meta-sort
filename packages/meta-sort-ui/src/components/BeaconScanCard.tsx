import { useEffect, useRef } from 'react';
import '../meta-beacon-scan.js';

/**
 * The Plugins page's beacon v2 Scan card: enrichment plugins advertising on
 * the network (`metamesh.enrich/<id>`, typically MetaPlugin* store apps), with
 * an Add per new one. A thin wrapper around the framework-free
 * <meta-beacon-scan> element shared with meta-share and meta-gateway; the
 * --mm-scan-* tokens map this dashboard's palette onto it.
 *
 * Add registers the plugin as an EXTERNAL plugin (POST /api/plugins/external):
 * meta-sort calls it by URL and never starts or stops it.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace JSX {
        interface IntrinsicElements {
            'meta-beacon-scan': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
                'scan-endpoint'?: string;
                'add-endpoint'?: string;
                'add-extra'?: string;
                label?: string;
            };
        }
    }
}

const TOKENS = {
    display: 'block',
    '--mm-scan-fg': 'var(--text-primary)',
    '--mm-scan-bg': 'var(--bg-secondary)',
    '--mm-scan-border': 'var(--border-color)',
    '--mm-scan-accent': 'var(--accent-primary)',
    '--mm-scan-err': 'var(--accent-secondary)',
} as React.CSSProperties;

function BeaconScanCard({ onAdded }: { onAdded: () => void }) {
    const ref = useRef<HTMLElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const handler = () => onAdded();
        el.addEventListener('beacon-added', handler);
        return () => el.removeEventListener('beacon-added', handler);
    }, [onAdded]);

    return (
        <meta-beacon-scan
            ref={ref}
            style={TOKENS}
            scan-endpoint="/api/plugins/discover"
            add-endpoint="/api/plugins/external"
            label="enrichment plugins"
        />
    );
}

export default BeaconScanCard;
