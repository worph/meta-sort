export class TwoStringsOperation {
    longestCommonSubseq(a: string, b: string, caseSensitive: boolean): string {
        const lengths: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        let tmpA: string, tmpB: string;

        for (let i = 0; i < a.length; i++) {
            for (let j = 0; j < b.length; j++) {
                if (caseSensitive) {
                    tmpA = a.charAt(i);
                    tmpB = b.charAt(j);
                } else {
                    tmpA = a.charAt(i).toLowerCase();
                    tmpB = b.charAt(j).toLowerCase();
                }
                if (tmpA === tmpB) {
                    lengths[i + 1][j + 1] = lengths[i][j] + 1;
                } else {
                    lengths[i + 1][j + 1] = Math.max(lengths[i + 1][j], lengths[i][j + 1]);
                }
            }
        }

        // Read the substring out from the matrix
        let sb = '';
        for (let x = a.length, y = b.length; x !== 0 && y !== 0;) {
            if (lengths[x][y] === lengths[x - 1][y]) {
                x--;
            } else if (lengths[x][y] === lengths[x][y - 1]) {
                y--;
            } else {
                sb = a.charAt(x - 1) + sb;
                x--;
                y--;
            }
        }

        return sb;
    }

    getLevenshteinDistance(s: string, t: string): number {
        if (s === null || t === null) {
            throw new Error("Strings must not be null");
        }

        const n = s.length; // length of s
        const m = t.length; // length of t

        if (n === 0) {
            return m;
        } else if (m === 0) {
            return n;
        }

        let p: number[] = Array.from({ length: n + 1 }, (_, i) => i); // 'previous' cost array, horizontally
        let d: number[] = new Array(n + 1); // cost array, horizontally
        let _d: number[]; // placeholder to assist in swapping p and d

        let cost: number;

        for (let j = 1; j <= m; j++) {
            const t_j = t.charAt(j - 1);
            d[0] = j;

            for (let i = 1; i <= n; i++) {
                cost = s.charAt(i - 1) === t_j ? 0 : 1;
                // minimum of cell to the left+1, to the top+1, diagonally left and up +cost
                d[i] = Math.min(Math.min(d[i - 1] + 1, p[i] + 1), p[i - 1] + cost);
            }

            // copy current distance counts to 'previous row' distance counts
            _d = p;
            p = d;
            d = _d;
        }

        // our last action in the above loop was to switch d and p, so p now
        // actually has the most recent cost counts
        return p[n];
    }
}
