const PriorityQueue = require('../../src/engine/pathfinding/priorityQueue');

function numberQueue() {
  return new PriorityQueue((a, b) => a - b);
}

describe('PriorityQueue', () => {
  it('starts empty', () => {
    const pq = numberQueue();
    expect(pq.isEmpty()).toBe(true);
    expect(pq.size).toBe(0);
    expect(pq.pop()).toBeUndefined();
  });

  it('pops items in ascending order regardless of push order', () => {
    const pq = numberQueue();
    [5, 1, 4, 2, 8, 0, 9, 3, 7, 6].forEach((n) => pq.push(n));

    const popped = [];
    while (!pq.isEmpty()) popped.push(pq.pop());

    expect(popped).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('peek returns the minimum without removing it', () => {
    const pq = numberQueue();
    pq.push(3);
    pq.push(1);
    pq.push(2);
    expect(pq.peek()).toBe(1);
    expect(pq.size).toBe(3);
  });

  it('handles duplicate values correctly', () => {
    const pq = numberQueue();
    [2, 2, 1, 1, 3].forEach((n) => pq.push(n));
    const popped = [];
    while (!pq.isEmpty()) popped.push(pq.pop());
    expect(popped).toEqual([1, 1, 2, 2, 3]);
  });

  it('works with object items and a custom comparator', () => {
    const pq = new PriorityQueue((a, b) => a.f - b.f);
    pq.push({ id: 'a', f: 10 });
    pq.push({ id: 'b', f: 3 });
    pq.push({ id: 'c', f: 7 });
    expect(pq.pop().id).toBe('b');
    expect(pq.pop().id).toBe('c');
    expect(pq.pop().id).toBe('a');
  });

  it('maintains heap order under interleaved push/pop', () => {
    const pq = numberQueue();
    pq.push(5);
    pq.push(3);
    expect(pq.pop()).toBe(3);
    pq.push(1);
    pq.push(4);
    expect(pq.pop()).toBe(1);
    pq.push(2);
    expect(pq.pop()).toBe(2);
    expect(pq.pop()).toBe(4);
    expect(pq.pop()).toBe(5);
    expect(pq.isEmpty()).toBe(true);
  });

  it('handles a large random workload correctly (stress test)', () => {
    const pq = numberQueue();
    const values = Array.from({ length: 2000 }, () => Math.floor(Math.random() * 100000));
    values.forEach((v) => pq.push(v));

    const popped = [];
    while (!pq.isEmpty()) popped.push(pq.pop());

    const expected = [...values].sort((a, b) => a - b);
    expect(popped).toEqual(expected);
  });
});
