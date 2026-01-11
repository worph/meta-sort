import lodash from 'lodash';
import {HashMeta} from "@metazla/meta-interface";

/**
 * Merge the new metadata into the old metadata
 * @param existingMetadata
 * @param newMetadata
 * @param id
 * @returns {boolean} true if the metadata has changed
 */
export function mergeMetadata(existingMetadata: any, newMetadata: any, id?:string): boolean{
    let hasChanged = false;
    const mergeLogic = (existingVal:any, newVal:any, key:string) => {
        if ((lodash.isObject(existingVal) || lodash.isObject(newVal)) ||
            (lodash.isArray(existingVal) || lodash.isArray(newVal))) {
            // Recursively merge objects and arrays
            return lodash.mergeWith(existingVal, newVal, mergeLogic);
        }

        if (existingVal) {
            if (!lodash.isEqual(""+existingVal, ""+newVal)){
                //conflict on primitive types
                console.warn(`Conflict found for '${id}'. Existing value: '${existingVal}', New value: '${newVal}'.`);
            }
            // Keep the original value (especially in case of conflict)
            return existingVal;
        }else {
            if(newVal !== undefined) {
                hasChanged = true;
            }
            return newVal;
        }
    };
    lodash.mergeWith(existingMetadata, newMetadata, mergeLogic);
    return hasChanged;
}
