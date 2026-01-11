import {TwoStringsOperation} from './TwoStringsOperation.js';

export class StringArrayOperation {
    private tso = new TwoStringsOperation();

    longestString(strings: string[]): string {
        let longest = '';
        strings.forEach(str => {
            if (str && (str.length > longest.length)) {
                longest = str;
            }
        });
        return longest;
    }

    findUniqueCommonSubstring(data: string[]): string {
        let sortedEntries = this.findCommonSubstring(data);
        return sortedEntries.length > 0 ? sortedEntries[0][0] : '';
    }

    findCommonSubstring(data: string[]): [string,number][] {
        let minStringLength = 4;
        let finalData: Map<string, number> = new Map();

        data.forEach(name1 => {
            data.forEach(name2 => {
                let strcmp = this.tso.longestCommonSubseq(name2, name1, false);
                if (strcmp.length >= minStringLength) {
                    finalData.set(strcmp, (finalData.get(strcmp) || 0) + 1);
                }
            });
        });

        return Array.from(finalData.entries()).sort((a, b) => b[1] - a[1]);
    }

    isStringsSimilar(strings: string[]): number {
        let distance = 0.0;
        let cmp = 0;

        strings.forEach(af1 => {
            strings.forEach(af2 => {
                if (af1 !== af2) {
                    distance += Math.abs(this.tso.getLevenshteinDistance(af1, af2));
                    cmp++;
                }
            });
        });

        return cmp === 0 ? -1 : distance / cmp;
    }
}
