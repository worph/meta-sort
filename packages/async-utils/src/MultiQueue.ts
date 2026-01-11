import {PromiseQueue} from "./PromiseQueue";

export class MultiQueue<T> {
    private readonly queues:PromiseQueue<T>[];

    /**
     *
     * @param concurrentTask
     */
    constructor(
        concurrentTask:number=1,
    ) {
        if (concurrentTask<1){
            throw new Error("concurrentTask must be >=1");
        }
        this.queues = [];
        for(let i=0;i<concurrentTask;i++){
            this.queues.push(new PromiseQueue<T>());
        }
    }

    public getQueueSize(): number {
        let ret = 0;
        for(let queue of this.queues){
            ret+=queue.getQueueSize();
        }
        return ret;
    }

    public async awaitQueueEmpty(){
        for(let queue of this.queues){
            await queue.awaitQueueEmpty();
        }
    }

    /**
     * Add a task to the queue. The queue with the smallest task size is used
     * @param task
     * @param id
     **/
    public add(task: () => Promise<T>, id: string = null): { id: string, promise: Promise<T> } {
        let queue = this.queues[0];
        for(let i=1;i<this.queues.length;i++){
            if(this.queues[i].getQueueSize()<queue.getQueueSize()){
                queue = this.queues[i];
            }
        }
        return queue.add(task,id);
    }

    public cancel(id: string) {
        for(let queue of this.queues){
            queue.cancel(id);
        }
    }

    /**
     * The last task in progress is not canceled
     */
    public async cancelAll(){
        for(let queue of this.queues){
            await queue.cancelAll();
        }
    }

}
