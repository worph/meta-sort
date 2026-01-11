export function from<T>(metadata: T): MetadataNode<T> {
    return new MetadataNode<T>([], metadata);
}

export class MetadataNode<T> {
    constructor(private path: string[], private rootData: any, private replacementRule?: (oldValue: T, newValue: T) => T) {
        this.replacementRule = replacementRule || ((oldValue: T, newValue: T) => {
            console.warn(`Key ${path.join('.')} already exists and no replacement rule defined (default to taking the new one).
            Current value: ${oldValue}
            New value: ${newValue}`);
            return newValue;
        });
    }

    // Navigate to a subnode without ensuring it exists for further operations
    at<K extends keyof T>(key: K): MetadataNode<T[K]> {
        if (!key) {
            throw new Error('Key is required');
        }
        const newPath = [...this.path, key as string];
        return new MetadataNode<T[K]>(newPath, this.rootData);
    }

    // Set the value at the current node, ensuring the path exists
    set(value: T): void {
        if (value === undefined || value === null) {
            //we don't want to set undefined or null values
            return;
        }
        const current = this.ensurePath(true);
        if (this.path.length > 0) {
            const lastKey = this.path[this.path.length - 1];
            if (current[lastKey]) {
                if (current[lastKey] === value) {
                    return;
                }
                current[lastKey] = this.replacementRule(current[lastKey], value);
            } else {
                current[lastKey] = value;
            }
        }
    }

    // Get the value at the current node
    get(defaultValue?: T): T {
        const current = this.ensurePath(false);
        return current === undefined ? defaultValue : current;
    }

    // this is used to define set of values
    add(key: string): void {
        if (key === undefined || key === null) {
            //we don't want to set undefined or null values
            return;
        }
        let node = this.get();
        if (node && node instanceof Set) {
            const set = node as Set<string>;
            if (set.has(key)) {
                return;
            } else {
                set.add(key);
            }
        } else {
            this.set(new Set([key]) as any);
        }
    }

    // Remove a key from the node
    /*remove<K extends keyof T>(key: K|string): void {
        const current = this.ensurePath(false);
        if (current && current[key] !== undefined) {
            delete current[key];
        }
    }*/

    // Get all keys at the current node
    getKeysAsSet(): Set<string> {
        const current = this.ensurePath(false);
        if(current instanceof Set){
            return current as Set<string>;
        }else {
            return new Set(current ? Object.keys(current) as Array<string> : []);
        }
    }

    getKeysAsArray(): string[] {
        const current = this.ensurePath(false);
        if(!current){
            return [];
        }
        if(current instanceof Set){
            return Array.from(current as Set<string>);
        }else {
            return Object.keys(current);
        }

    }

    private ensurePath(createPath: boolean): any {
        let current = this.rootData;
        const path = createPath ? this.path.slice(0, -1) : this.path;
        for (const segment of path) {
            if (current[segment] === undefined) {
                if (createPath) {
                    current[segment] = {};
                } else {
                    return undefined; // Return undefined early if the path segment doesn't exist and we're not creating it
                }
            }
            current = current[segment];
        }
        return current;
    }
}
