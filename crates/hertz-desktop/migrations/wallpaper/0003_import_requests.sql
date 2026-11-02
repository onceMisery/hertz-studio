-- SPDX-License-Identifier: MIT
-- 请求受理事实与 install_jobs 共用同一持久表，重启后不丢幂等身份。
CREATE UNIQUE INDEX install_jobs_request ON install_jobs(request_id)
    WHERE request_id IS NOT NULL;
