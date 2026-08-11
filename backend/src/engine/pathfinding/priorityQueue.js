/**
 * A generic binary min-heap. A*'s open set needs "give me the lowest-cost
 * node so far, quickly" over and over - a plain array with a linear scan
 * would work but degrades on larger grids; a heap keeps push/pop at
 * O(log n). No decrease-key operation is implemented on purpose: A* below
 * handles cost updates with the standard "push a new entry, ignore stale
 * ones on pop" lazy-deletion pattern instead, which is simpler and just as
 * correct for this use case.
 */
class PriorityQueue {
  constructor(compare) {
    this._compare = compare;
    this._items = [];
  }

  get size() {
    return this._items.length;
  }

  isEmpty() {
    return this._items.length === 0;
  }

  peek() {
    return this._items[0];
  }

  push(item) {
    const items = this._items;
    items.push(item);
    this._bubbleUp(items.length - 1);
  }

  pop() {
    const items = this._items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }

  _bubbleUp(startIndex) {
    const items = this._items;
    let index = startIndex;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (this._compare(items[index], items[parentIndex]) >= 0) break;
      this._swap(index, parentIndex);
      index = parentIndex;
    }
  }

  _bubbleDown(startIndex) {
    const items = this._items;
    const length = items.length;
    let index = startIndex;
    for (;;) {
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      let smallest = index;

      if (left < length && this._compare(items[left], items[smallest]) < 0) smallest = left;
      if (right < length && this._compare(items[right], items[smallest]) < 0) smallest = right;
      if (smallest === index) break;

      this._swap(index, smallest);
      index = smallest;
    }
  }

  _swap(i, j) {
    const items = this._items;
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}

module.exports = PriorityQueue;
