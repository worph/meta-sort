// used to simulate array using map and object
export type ArrayKey = "id_0" | "id_1" | "id_2" | "id_3" | "id_4" | "id_5" | "id_6" | "id_7" | "id_8" | "id_9";

export function createArrayKey (index: number): ArrayKey {
    return `id_${index}` as ArrayKey;
}