# Function Analysis and Fixes

## 1. findMedianSortedArrays - Overflow Issue

### Concrete Failure Case
```typescript
const nums1 = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
const nums2 = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
// Expected: (MAX_SAFE_INTEGER - 1 + MAX_SAFE_INTEGER) / 2 = MAX_SAFE_INTEGER - 0.5
// Actual: Returns -1 due to overflow in (merged[mid-1] + merged[mid])
```

## 2. kthSmallest - Off-by-One Error with Duplicates

### Exact Failure Case
```typescript
const matrix = [
  [1, 1, 1],
  [1, 1, 1],
  [1, 1, 1]
];
const k = 9; // k equals matrix size (3x3 = 9 elements)
// Expected: 1 (the 9th smallest element)
// Actual: Returns undefined because flat[k-1] = flat[8] is undefined (flat.length = 9)
```

## 3. findMedianSortedArrays - O(log(min(m,n))) Solution

### Binary Search Approach
The optimal solution uses binary search on the smaller array to partition both arrays such that:
- Left side has (m + n + 1) / 2 elements
- Right side has remaining elements
- Max of left <= min of right

Key insights:
1. Binary search on the smaller array
2. Find partition point where elements on left <= elements on right
3. Handle even/odd length cases
4. Handle edge cases when partition is at array boundary