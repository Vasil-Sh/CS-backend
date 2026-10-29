import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({execute:vi.fn(),transaction:vi.fn(),user:{id:7,username:'fixture',priceMonth:'25',startDate:'2026-10-29',endDate:'2026-11-28'}}));
vi.mock('../db/client',()=>({schema:{users:{username:'username'}},db:{select:()=>({from:()=>({where:()=>({limit:async()=>[]})})}),transaction:mocks.transaction}}));
vi.mock('bcryptjs',()=>({default:{hash:async()=>'hash'}}));
vi.mock('../utils/jwt',()=>({signToken:vi.fn(),signRefreshToken:vi.fn()}));
import {AuthService} from './authService';
describe('registration payment',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.user.priceMonth='25';mocks.execute.mockResolvedValue({});mocks.transaction.mockImplementation(async fn=>fn({insert:()=>({values:()=>({returning:async()=>[mocks.user]})}),execute:mocks.execute}));});
 it('writes first payment and its audit inside the user transaction',async()=>{const result=await new AuthService().register({username:'fixture',priceMonth:'25'},{userId:1,username:'admin'});expect(result?.userId).toBe(7);expect(mocks.transaction).toHaveBeenCalledTimes(1);expect(mocks.execute).toHaveBeenCalledTimes(2)});
 it('does not create a payment for free access',async()=>{mocks.user.priceMonth='0';await new AuthService().register({username:'fixture'},{userId:1,username:'admin'});expect(mocks.execute).not.toHaveBeenCalled()});
 it('does not report success when payment persistence fails',async()=>{mocks.execute.mockRejectedValueOnce(new Error('payment failed'));await expect(new AuthService().register({username:'fixture'},{userId:1,username:'admin'})).rejects.toThrow('payment failed')});
});
