import { RabbitMQConnectionFacade } from '../connection/RabbitMQConnectionFacade';
import { Mercury } from '../Mercury';
import { MessageBus, OptionsMap } from './MessageBus';

export class RabbitMQMessageBus implements MessageBus {
    private connectionFacade: RabbitMQConnectionFacade;

    public async configure(args: OptionsMap): Promise<boolean> {
        const {
            brokerHostName,
            brokerUserName,
            brokerPassword,
            appName,
            serviceName,
            retryDelay,
            filterMessages,
        } = args;
        this.connectionFacade = new RabbitMQConnectionFacade(serviceName, appName, retryDelay, filterMessages);
        try {
            await this.connectionFacade.connect(brokerHostName, brokerUserName, brokerPassword);
            const messageBindings: Map<string, string> = Reflect.getMetadata('messageBindings', Mercury);
            await this.connectionFacade.subscribeAll(messageBindings);
            return true;
        } catch (e) {
            throw e;
        }
    }
}
