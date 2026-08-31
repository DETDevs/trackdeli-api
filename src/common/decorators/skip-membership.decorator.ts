import { SetMetadata } from '@nestjs/common';

export const SKIP_MEMBERSHIP_KEY = 'skipMembershipCheck';
export const SkipMembershipCheck = () => SetMetadata(SKIP_MEMBERSHIP_KEY, true);
export const SkipMembership = SkipMembershipCheck;
