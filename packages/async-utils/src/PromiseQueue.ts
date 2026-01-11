import {makeid} from "./Id";

export class PromiseQueue<T> {
    private nextPromise: Promise<T> = Promise.resolve(null);
    private canceled = {};
    private queueSize = 0;
    private queueID = 0;

    /**
     *
     * @param onlyLast if true all task are cancel and only the last one is keep alive (a task started still finishes)
     */
    constructor(
        private onlyLast: boolean = false
    ) {
        this.cancelAll();
    }

    getQueueSize(): number {
        return this.queueSize;
    }

    async awaitQueueEmpty(){
        await this.nextPromise;//await the current promise
        while (this.queueSize!=0){//await all the fowllofing promise
            await this.nextPromise;
        }
    }

    add(task: () => Promise<T>, id: string = null): { id: string, promise: Promise<T> } {
        if (!id) {
            id = "promise-" + makeid(8);
        }
        let lastPromise = this.nextPromise;
        this.queueSize++;
        let currentID = this.queueID;
        let currentPromise=null;
        currentPromise = (async () => {
            this.queueSize--;
            try {
                await lastPromise;
            }catch (e) {
                /* ignore error of previous promise*/
            }
            if(currentID!==this.queueID){
                throw new Error("canceled caused by new queue");
            }
            if (this.canceled[id]) {
                delete this.canceled[id];
                throw new Error("canceled by user");
            }
            if(this.onlyLast && currentPromise!=this.nextPromise){
                throw new Error("canceled caused by not last");
            }
            //execute task and return result
            return task();
        })();
        currentPromise.catch(e=>{
            /* we catch the exception this way to avoid an uncaught exception in the console*/
        });
        this.nextPromise = currentPromise
        return {id, promise: this.nextPromise};
    }

    cancel(id: string) {
        this.canceled[id] = true;
    }

    /**
     * The last task in progress is not canceled
     */
    async cancelAll(){
        this.queueID++;//create a new queue will cancel all previous task except the one in progress
        await this.awaitQueueEmpty();
        this.nextPromise = Promise.resolve(null);
        this.canceled = {};
        this.queueSize = 0;
    }

}
