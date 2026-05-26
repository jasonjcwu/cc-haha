/**
 * 双向链表实现
 */
// 节点类
class Node {
    constructor(value) {
        this.next = null;
        this.prev = null;
        this.value = value;
    }
}
// 双向链表类
export class DoublyLinkedList {
    constructor() {
        this.head = null;
        this.tail = null;
        this._size = 0;
    }
    // 获取链表长度
    get size() {
        return this._size;
    }
    // 判断链表是否为空
    get isEmpty() {
        return this._size === 0;
    }
    // 在链表尾部添加节点
    append(value) {
        const newNode = new Node(value);
        if (this.isEmpty) {
            this.head = newNode;
            this.tail = newNode;
        }
        else {
            newNode.prev = this.tail;
            this.tail.next = newNode;
            this.tail = newNode;
        }
        this._size++;
    }
    // 在链表头部添加节点
    prepend(value) {
        const newNode = new Node(value);
        if (this.isEmpty) {
            this.head = newNode;
            this.tail = newNode;
        }
        else {
            newNode.next = this.head;
            this.head.prev = newNode;
            this.head = newNode;
        }
        this._size++;
    }
    // 在指定索引位置插入节点
    insertAt(index, value) {
        // 检查索引是否有效
        if (index < 0 || index > this._size) {
            throw new Error(`Index ${index} out of bounds`);
        }
        // 在头部插入
        if (index === 0) {
            this.prepend(value);
            return;
        }
        // 在尾部插入
        if (index === this._size) {
            this.append(value);
            return;
        }
        // 在中间插入
        const newNode = new Node(value);
        const currentNode = this.getNodeAt(index);
        newNode.prev = currentNode.prev;
        newNode.next = currentNode;
        currentNode.prev.next = newNode;
        currentNode.prev = newNode;
        this._size++;
    }
    // 删除指定索引位置的节点
    remove(index) {
        // 检查索引是否有效
        if (index < 0 || index >= this._size) {
            throw new Error(`Index ${index} out of bounds`);
        }
        if (index === 0) {
            return this.removeHead();
        }
        if (index === this._size - 1) {
            return this.removeTail();
        }
        const currentNode = this.getNodeAt(index);
        const prevNode = currentNode.prev;
        const nextNode = currentNode.next;
        prevNode.next = nextNode;
        nextNode.prev = prevNode;
        this._size--;
        return currentNode.value;
    }
    // 获取指定索引位置的节点值
    get(index) {
        const node = this.getNodeAt(index);
        return node ? node.value : undefined;
    }
    // 设置指定索引位置的节点值
    set(index, value) {
        const node = this.getNodeAt(index);
        if (!node) {
            throw new Error(`Index ${index} out of bounds`);
        }
        node.value = value;
    }
    // 检查链表是否包含某个值
    contains(value) {
        let current = this.head;
        while (current) {
            if (current.value === value) {
                return true;
            }
            current = current.next;
        }
        return false;
    }
    // 反转链表
    reverse() {
        let current = this.head;
        let temp = null;
        // 交换所有节点的prev和next指针
        while (current) {
            temp = current.prev;
            current.prev = current.next;
            current.next = temp;
            current = current.prev;
        }
        // 交换head和tail
        temp = this.head;
        this.head = this.tail;
        this.tail = temp;
        return this;
    }
    // 将链表转换为数组
    toArray() {
        const result = [];
        let current = this.head;
        let visited = new Set();
        while (current && !visited.has(current)) {
            visited.add(current);
            result.push(current.value);
            current = current.next;
        }
        return result;
    }
    // 清空链表
    clear() {
        this.head = null;
        this.tail = null;
        this._size = 0;
    }
    // 获取指定索引位置的节点
    getNodeAt(index) {
        if (index < 0 || index >= this._size) {
            return null;
        }
        let current = this.head;
        for (let i = 0; i < index; i++) {
            current = current.next;
        }
        return current;
    }
    // 删除头部节点
    removeHead() {
        if (!this.head)
            return undefined;
        const value = this.head.value;
        if (this._size === 1) {
            this.head = null;
            this.tail = null;
        }
        else {
            this.head = this.head.next;
            this.head.prev = null;
        }
        this._size--;
        return value;
    }
    // 删除尾部节点
    removeTail() {
        if (!this.tail)
            return undefined;
        const value = this.tail.value;
        if (this._size === 1) {
            this.head = null;
            this.tail = null;
        }
        else {
            this.tail = this.tail.prev;
            this.tail.next = null;
        }
        this._size--;
        return value;
    }
    // 实现迭代器接口
    *values() {
        let current = this.head;
        while (current) {
            yield current.value;
            current = current.next;
        }
    }
    *[Symbol.iterator]() {
        yield* this.values();
    }
}
// 循环双向链表类
export class CircularDoublyLinkedList extends DoublyLinkedList {
    append(value) {
        super.append(value);
        // 循环处理
        if (this.tail) {
            this.tail.next = this.head;
            this.head.prev = this.tail;
        }
    }
    prepend(value) {
        super.prepend(value);
        // 循环处理
        if (this.head) {
            this.tail.next = this.head;
            this.head.prev = this.tail;
        }
    }
    removeHead() {
        const value = super.removeHead();
        if (this.head) {
            this.tail.next = this.head;
            this.head.prev = this.tail;
        }
        return value;
    }
    removeTail() {
        const value = super.removeTail();
        if (this.tail) {
            this.tail.next = this.head;
            this.head.prev = this.tail;
        }
        return value;
    }
    clear() {
        super.clear();
        // 清空后不再循环
    }
}
// 导出节点类供测试使用
export { Node };
