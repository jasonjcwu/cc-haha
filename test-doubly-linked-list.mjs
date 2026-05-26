/**
 * 双向链表测试
 */

import { DoublyLinkedList, CircularDoublyLinkedList } from './dist/doubly-linked-list.js';

console.log('=== 开始测试双向链表 ===\n');

// 基础功能测试
console.log('1. 基础功能测试');
const list = new DoublyLinkedList();

// 测试初始状态
console.log(`初始大小: ${list.size}, 是否为空: ${list.isEmpty}`);

// 添加元素
list.append(1);
list.append(2);
list.append(3);
console.log(`添加 1,2,3 后: ${list.toArray().join(',')}`);

list.prepend(0);
console.log(`在头部添加 0 后: ${list.toArray().join(',')}`);

// 测试获取元素
console.log(`索引 1 的值: ${list.get(1)}`);
console.log(`索引 3 的值: ${list.get(3)}`);

// 测试设置元素
list.set(2, 99);
console.log(`设置索引 2 为 99 后: ${list.toArray().join(',')}`);

// 测试插入
list.insertAt(1, 10);
console.log(`在索引 1 插入 10 后: ${list.toArray().join(',')}`);

// 测试删除
const removed = list.remove(2);
console.log(`删除索引 2 的值（值为 ${removed}）后: ${list.toArray().join(',')}`);

// 测试包含
console.log(`是否包含 99: ${list.contains(99)}`);
console.log(`是否包含 100: ${list.contains(100)}`);

// 测试反转
list.reverse();
console.log(`反转后: ${list.toArray().join(',')}`);

// 测试清空
list.clear();
console.log(`清空后大小: ${list.size}, 是否为空: ${list.isEmpty}`);

console.log('\n2. 边界条件测试');
const emptyList = new DoublyLinkedList();

// 测试空链表
console.log(`空链表 toArray: ${emptyList.toArray().join(',')}`);
console.log(`空链表 contains 'a': ${emptyList.contains('a')}`);

// 测试单节点链表
const singleNodeList = new DoublyLinkedList();
singleNodeList.append(1);
console.log(`单节点链表: ${singleNodeList.toArray().join(',')}`);
console.log(`单节点反转: ${singleNodeList.reverse().toArray().join(',')}`);

// 测试双节点链表
const twoNodeList = new DoublyLinkedList();
twoNodeList.append(1);
twoNodeList.append(2);
console.log(`双节点链表: ${twoNodeList.toArray().join(',')}`);
twoNodeList.reverse();
console.log(`双节点反转: ${twoNodeList.toArray().join(',')}`);

// 测试错误处理
try {
  emptyList.get(0);
} catch (error) {
  console.log(`正确捕获错误: ${error.message}`);
}

try {
  emptyList.insertAt(1, 'a');
} catch (error) {
  console.log(`正确捕获错误: ${error.message}`);
}

console.log('\n3. 迭代器测试');
const iterList = new DoublyLinkedList();
iterList.append('a');
iterList.append('b');
iterList.append('c');

console.log('使用 for...of 遍历:');
for (const item of iterList) {
  console.log(item);
}

console.log('\n展开运算符:');
console.log([...iterList]);

console.log('\n4. 性能测试');
const perfList = new DoublyLinkedList();
const startTime = performance.now();

// 添加大量元素
for (let i = 0; i < 10000; i++) {
  perfList.append(i);
  perfList.prepend(i);
}

// 反转测试
perfList.reverse();

const endTime = performance.now();
console.log(`处理 20000 个元素耗时: ${(endTime - startTime).toFixed(2)}ms`);
console.log(`最终列表大小: ${perfList.size}`);
console.log(`前10个元素: ${perfList.toArray().slice(0, 10).join(',')}`);

console.log('\n5. 循环双向链表测试');
const circularList = new CircularDoublyLinkedList();
circularList.append(1);
circularList.append(2);
circularList.append(3);

console.log(`循环列表: ${circularList.toArray().join(',')}`);
console.log(`头部节点的下一个节点值: ${circularList.toArray()[0]}, ${circularList.head?.next?.value}`);
console.log(`尾部节点的上一个节点值: ${circularList.toArray()[circularList.size - 1]}, ${circularList.tail?.prev?.value}`);

// 测试循环删除
circularList.remove(0);
console.log(`删除头部后: ${circularList.toArray().join(',')}`);
console.log(`新的头部节点的上一个节点: ${circularList.head?.prev?.value}`);

console.log('\n=== 所有测试完成 ===');