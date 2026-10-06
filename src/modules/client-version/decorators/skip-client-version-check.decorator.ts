import { SetMetadata } from '@nestjs/common';
import { SKIP_CLIENT_VERSION_CHECK_KEY } from '../client-version.constants';

export const SkipClientVersionCheck = () => SetMetadata(SKIP_CLIENT_VERSION_CHECK_KEY, true);
