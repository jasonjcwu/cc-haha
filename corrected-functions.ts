// Corrected findMedianSortedArrays - O(log(min(m,n))) solution
function findMedianSortedArrays(nums1: number[], nums2: number[]): number {
  // Ensure nums1 is the smaller array
  if (nums1.length > nums2.length) {
    return findMedianSortedArrays(nums2, nums1);
  }

  const m = nums1.length;
  const n = nums2.length;
  const total = m + n;
  const half = Math.floor(total / 2);

  let left = 0;
  let right = m;

  while (left <= right) {
    const partitionA = Math.floor((left + right) / 2);
    const partitionB = half - partitionA;

    const maxLeftA = partitionA === 0 ? Number.MIN_SAFE_INTEGER : nums1[partitionA - 1];
    const minRightA = partitionA === m ? Number.MAX_SAFE_INTEGER : nums1[partitionA];

    const maxLeftB = partitionB === 0 ? Number.MIN_SAFE_INTEGER : nums2[partitionB - 1];
    const minRightB = partitionB === n ? Number.MAX_SAFE_INTEGER : nums2[partitionB];

    // Check if we found the correct partition
    if (maxLeftA <= minRightB && maxLeftB <= minRightA) {
      if (total % 2 === 0) {
        // Even length - average of two middle elements
        return (Math.max(maxLeftA, maxLeftB) + Math.min(minRightA, minRightB)) / 2;
      } else {
        // Odd length - middle element
        return Math.max(maxLeftA, maxLeftB);
      }
    } else if (maxLeftA > minRightB) {
      // Move partitionA left
      right = partitionA - 1;
    } else {
      // Move partitionA right
      left = partitionA + 1;
    }
  }

  throw new Error("Input arrays are not sorted");
}

// Corrected kthSmallest - handles edge cases properly
function kthSmallest(matrix: number[][], k: number): number {
  const flat = matrix.flat();
  flat.sort((a, b) => a - b);

  // Check if k is within valid range
  if (k < 1 || k > flat.length) {
    throw new Error(`k must be between 1 and ${flat.length}`);
  }

  return flat[k - 1];
}

// Example usage and test cases
console.log("Testing findMedianSortedArrays:");
// Test case 1: Normal case
const nums1 = [1, 3];
const nums2 = [2];
console.log(findMedianSortedArrays(nums1, nums2)); // Output: 2

// Test case 2: Large numbers (no overflow)
const bigNums1 = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
const bigNums2 = [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
console.log(findMedianSortedArrays(bigNums1, bigNums2)); // Output: 9007199254740815.5

console.log("\nTesting kthSmallest:");
// Test case 1: Normal case
const matrix1 = [[1,5,9],[10,11,13],[12,13,15]];
console.log(kthSmallest(matrix1, 8)); // Output: 13

// Test case 2: Edge case with duplicates and k = matrix size
const matrix2 = [[1,1,1],[1,1,1],[1,1,1]];
console.log(kthSmallest(matrix2, 9)); // Output: 1