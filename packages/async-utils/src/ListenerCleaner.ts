export class ListenerCleaner {
    cleaners: (() => void)[] = [];

    add(cleanerCallback: () => void) {
        this.cleaners.push(cleanerCallback);
    }

    cleaner(): () => void {
        return () => {
            this.cleanUp();
        }
    }

    /**
     * Call all the cleaner callbacks and reset this cleaner to be reused.
     */
    cleanUp() {
        for (const cleaner of this.cleaners) {
            cleaner();
        }
        this.cleaners = [];
    }
}
