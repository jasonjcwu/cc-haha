/**
 * 双向链表实现
 */
declare class Node<T> {
    value: T;
    next: Node<T> | null;
    prev: Node<T> | null;
    constructor(value: T);
}
export declare class DoublyLinkedList<T> {
    protected head: Node<T> | null;
    protected tail: Node<T> | null;
    private _size;
    get size(): number;
    get isEmpty(): boolean;
    append(value: T): void;
    prepend(value: T): void;
    insertAt(index: number, value: T): void;
    remove(index: number): T | undefined;
    get(index: number): T | undefined;
    set(index: number, value: T): void;
    contains(value: T): boolean;
    reverse(): this;
    toArray(): T[];
    clear(): void;
    private getNodeAt;
    protected removeHead(): T | undefined;
    protected removeTail(): T | undefined;
    values(): Generator<T, void, unknown>;
    [Symbol.iterator](): Generator<T, void, unknown>;
}
export declare class CircularDoublyLinkedList<T> extends DoublyLinkedList<T> {
    append(value: T): void;
    prepend(value: T): void;
    removeHead(): T | undefined;
    removeTail(): T | undefined;
    clear(): void;
}
export { Node };
