-- SPDX-License-Identifier: MIT
-- Draft JSON now carries native-only immutable provenance. Advance the original
-- database version so an older app refuses to open it instead of dropping or
-- ignoring this field. Resource references remain the existing deletion owner.
SELECT 1;
