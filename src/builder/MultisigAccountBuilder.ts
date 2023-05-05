import { BigNumberish, BytesLike, ethers } from "ethers";
import { UserOperationBuilder, UserOperationMiddlewareFn } from "userop";
import {
  EntryPoint,
  EntryPoint__factory,
  MultisigAccountFactory,
  MultisigAccountFactory__factory,
  MultisigAccount as MultisigAccountImpl,
  MultisigAccount__factory,
} from "../../typechain-types";
import { estimateUserOperationGas } from "./gasLimit";
import { getGasPrice } from "./getGasPrice";
import { EOASignature } from "./signature";

export class MultisigAccount extends UserOperationBuilder {
  private signer: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private entryPoint: EntryPoint;
  private factory: MultisigAccountFactory;
  private initCode: string;
  proxy: MultisigAccountImpl;

  private constructor(
    signingKey: string,
    ERC4337NodeRpc: string,
    entryPoint: string,
    factory: string
  ) {
    super();
    this.signer = new ethers.Wallet(signingKey);
    this.provider = new ethers.providers.JsonRpcProvider(ERC4337NodeRpc);
    this.entryPoint = EntryPoint__factory.connect(entryPoint, this.provider);
    this.factory = MultisigAccountFactory__factory.connect(
      factory,
      this.provider
    );
    this.initCode = "0x";
    this.proxy = MultisigAccount__factory.connect(
      ethers.constants.AddressZero,
      this.provider
    );
  }

  private resolveAccount: UserOperationMiddlewareFn = async (ctx) => {
    ctx.op.nonce = await this.entryPoint.getNonce(ctx.op.sender, 0);
    ctx.op.initCode = ctx.op.nonce.eq(0) ? this.initCode : "0x";
  };

  public static async init(
    signingKey: string,
    ERC4337NodeRpc: string,
    entryPoint: string,
    factory: string,
    paymasterMiddleware?: UserOperationMiddlewareFn
  ): Promise<MultisigAccount> {
    const instance = new MultisigAccount(
      signingKey,
      ERC4337NodeRpc,
      entryPoint,
      factory
    );

    try {
      instance.initCode = await ethers.utils.hexConcat([
        instance.factory.address,
        instance.factory.interface.encodeFunctionData("createAccount", [
          await instance.signer.getAddress(),
          ethers.BigNumber.from(0),
        ]),
      ]);
      await instance.entryPoint.callStatic.getSenderAddress(instance.initCode);

      throw new Error("getSenderAddress: unexpected result");
    } catch (error: any) {
      const addr = error?.errorArgs?.sender;
      if (!addr) throw error;

      instance.proxy = MultisigAccount__factory.connect(
        addr,
        instance.provider
      );
    }

    const base = instance
      .useDefaults({
        sender: instance.proxy.address,
        signature: await instance.signer.signMessage(
          ethers.utils.arrayify(ethers.utils.keccak256("0xdead"))
        ),
      })
      .useMiddleware(instance.resolveAccount)
      .useMiddleware(getGasPrice(instance.provider));

    const withPM = paymasterMiddleware
      ? base.useMiddleware(paymasterMiddleware)
      : base.useMiddleware(estimateUserOperationGas(instance.provider));

    return withPM.useMiddleware(EOASignature(instance.signer));
  }

  execute(to: string, value: BigNumberish, data: BytesLike) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("execute", [to, value, data])
    );
  }

  executeBatch(to: Array<string>, data: Array<BytesLike>) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("executeBatch", [to, data])
    );
  }
}
