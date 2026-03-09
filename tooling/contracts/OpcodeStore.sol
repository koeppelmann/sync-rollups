
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract OpcodeStore {
    uint256 public callCounter;

    function testArithmetic(uint256 a, uint256 b) external {
        callCounter++;
        assembly {
            // Slot 0: ADD
            sstore(0, add(a, b))
            // Slot 1: MUL
            sstore(1, mul(a, b))
            // Slot 2: SUB
            sstore(2, sub(a, b))
            // Slot 3: DIV (avoid div by 0)
            let bSafe := add(b, 1)
            sstore(3, div(a, bSafe))
            // Slot 4: SDIV
            sstore(4, sdiv(a, bSafe))
            // Slot 5: MOD
            sstore(5, mod(a, bSafe))
            // Slot 6: SMOD
            sstore(6, smod(a, bSafe))
            // Slot 7: ADDMOD
            sstore(7, addmod(a, b, bSafe))
            // Slot 8: MULMOD
            sstore(8, mulmod(a, b, bSafe))
            // Slot 9: EXP
            let expB := mod(b, 32) // limit exponent to avoid huge gas
            sstore(9, exp(a, expB))
        }
    }

    function testComparison(uint256 a, uint256 b) external {
        callCounter++;
        assembly {
            sstore(10, lt(a, b))
            sstore(11, gt(a, b))
            sstore(12, slt(a, b))
            sstore(13, sgt(a, b))
            sstore(14, eq(a, b))
            sstore(15, iszero(a))
        }
    }

    function testBitwise(uint256 a, uint256 b) external {
        callCounter++;
        assembly {
            sstore(20, and(a, b))
            sstore(21, or(a, b))
            sstore(22, xor(a, b))
            sstore(23, not(a))
            sstore(24, byte(0, a))
            sstore(25, shl(b, a))
            sstore(26, shr(b, a))
            sstore(27, sar(b, a))
        }
    }

    function testHashing(bytes calldata data) external {
        callCounter++;
        assembly {
            // Copy calldata to memory
            let len := data.length
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, len)
            // SHA3
            sstore(30, keccak256(ptr, len))
            sstore(31, len)
        }
    }

    function testEnvironment() external {
        callCounter++;
        assembly {
            sstore(40, address())
            sstore(41, balance(address()))
            sstore(42, origin())
            sstore(43, caller())
            sstore(44, callvalue())
            sstore(45, calldatasize())
            sstore(46, gasprice())
            sstore(47, coinbase())
            sstore(48, timestamp())
            sstore(49, number())
            sstore(50, gaslimit())
            sstore(51, chainid())
        }
    }

    function testMemory(uint256 seed) external {
        callCounter++;
        assembly {
            // MSTORE at various offsets
            mstore(0x00, seed)
            mstore(0x20, add(seed, 1))
            mstore(0x40, mul(seed, 2))
            // MSTORE8
            mstore8(0x60, seed)
            // MLOAD
            let v0 := mload(0x00)
            let v1 := mload(0x20)
            let v2 := mload(0x40)
            // Store results (MSIZE removed due to Yul optimizer incompatibility)
            sstore(60, v0)
            sstore(61, v1)
            sstore(62, v2)
            sstore(63, 0x80) // placeholder for msize
        }
    }

    function testStorage(uint256 slot, uint256 val) external {
        callCounter++;
        assembly {
            sstore(add(slot, 100), val)
            let loaded := sload(add(slot, 100))
            sstore(add(slot, 200), loaded)
        }
    }

    function testCodeOps() external {
        callCounter++;
        assembly {
            sstore(70, codesize())
            sstore(71, gas())
            sstore(72, returndatasize())
            sstore(73, selfbalance())
            // EXTCODESIZE of self
            sstore(74, extcodesize(address()))
            // EXTCODEHASH of self
            sstore(75, extcodehash(address()))
        }
    }

    function testCreate(bytes calldata code) external returns (address) {
        callCounter++;
        address created;
        assembly {
            let len := code.length
            let ptr := mload(0x40)
            calldatacopy(ptr, code.offset, len)
            created := create(0, ptr, len)
            sstore(80, created)
        }
        return created;
    }

    function testCreate2(bytes calldata code, bytes32 salt) external returns (address) {
        callCounter++;
        address created;
        assembly {
            let len := code.length
            let ptr := mload(0x40)
            calldatacopy(ptr, code.offset, len)
            created := create2(0, ptr, len, salt)
            sstore(81, created)
        }
        return created;
    }

    function testCallExternal(address target, bytes calldata data) external {
        callCounter++;
        assembly {
            let len := data.length
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, len)
            let success := call(gas(), target, 0, ptr, len, ptr, 0x20)
            sstore(90, success)
            sstore(91, mload(ptr))
        }
    }

    function testStaticCallExternal(address target, bytes calldata data) external {
        callCounter++;
        assembly {
            let len := data.length
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, len)
            let success := staticcall(gas(), target, ptr, len, ptr, 0x20)
            sstore(92, success)
            sstore(93, mload(ptr))
        }
    }

    function testDelegateCallExternal(address target, bytes calldata data) external {
        callCounter++;
        assembly {
            let len := data.length
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, len)
            let success := delegatecall(gas(), target, ptr, len, ptr, 0x20)
            sstore(94, success)
            sstore(95, mload(ptr))
        }
    }

    // Simple ETH receive
    receive() external payable {}

    function getSlot(uint256 slot) external view returns (uint256 val) {
        assembly {
            val := sload(slot)
        }
    }
}
