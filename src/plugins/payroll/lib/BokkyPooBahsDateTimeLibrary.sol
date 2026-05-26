// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// ----------------------------------------------------------------------------
// BokkyPooBah's DateTime Library v1.01 — minimal vendored subset.
//
// Original: https://github.com/bokkypoobah/BokkyPooBahsDateTimeLibrary
// (c) BokkyPooBah / Bok Consulting Pty Ltd 2018-2019. The MIT Licence.
//
// PayrollPlugin only needs `timestampToDate`, so only that function plus its
// supporting `_daysToDate` math and constants are vendored. The original
// algorithm is by Howard Hinnant — see
// http://howardhinnant.github.io/date_algorithms.html.
// ----------------------------------------------------------------------------
library BokkyPooBahsDateTimeLibrary {
    uint256 constant SECONDS_PER_DAY = 24 * 60 * 60;
    int256 constant OFFSET19700101 = 2440588;

    /// @dev Returns the (year, month, day) for a unix-epoch day count.
    function _daysToDate(uint256 _days)
        internal
        pure
        returns (uint256 year, uint256 month, uint256 day)
    {
        int256 __days = int256(_days);

        int256 L = __days + 68569 + OFFSET19700101;
        int256 N = (4 * L) / 146097;
        L = L - (146097 * N + 3) / 4;
        int256 _year = (4000 * (L + 1)) / 1461001;
        L = L - (1461 * _year) / 4 + 31;
        int256 _month = (80 * L) / 2447;
        int256 _day = L - (2447 * _month) / 80;
        L = _month / 11;
        _month = _month + 2 - 12 * L;
        _year = 100 * (N - 49) + _year + L;

        year = uint256(_year);
        month = uint256(_month);
        day = uint256(_day);
    }

    /// @dev Returns the (year, month, day) for a unix-epoch timestamp.
    function timestampToDate(uint256 timestamp)
        internal
        pure
        returns (uint256 year, uint256 month, uint256 day)
    {
        (year, month, day) = _daysToDate(timestamp / SECONDS_PER_DAY);
    }
}
